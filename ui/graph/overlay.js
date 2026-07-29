// The part of the graph a person made, kept apart from the part that is
// derived.
//
// The skeleton is rebuilt from the timeline every time the timeline moves —
// that is what makes the Graph stage a picture of the edit rather than a copy
// of it — and a rebuild throws away every node object it made last time. So
// anything you inserted or typed has to live somewhere a rebuild cannot reach,
// and has to be re-attachable to a skeleton it has never seen. That is this
// file: two small pieces of data and the rules for putting them back.
//
// **Anchors, not positions.** A user node is pinned to a named insert point
// (`clip:7/after-scale`), never to an index in an array, because the array is
// regenerated and the index means something different afterwards. `derive.js`
// declares the points and `applyOverlay` puts the nodes back at them. An anchor
// whose point is not in this graph — a clip trimmed out of the render range —
// is not an error and is not thrown away either: it is a node that does not
// apply to what is being rendered right now, and it comes back when the clip
// does.
//
// **A lock is a value that outranks the derivation, and it is per node.**
// Editing a param on a derived node records the value here, against that node's
// anchor; the skeleton around it still regenerates. What must never happen is
// the timeline quietly reverting something you typed — that is worse than the
// edit not applying, because at least the second one is visible — so `derive.js`
// reports every override it applied and the panel and the spine say so.
//
// **Structure, not only settings.** A splice was expressible as one string —
// the name of the wire it went on — because a spliced filter has one input and
// one output and there is only one thing it can be attached to. Nothing else in
// libavfilter is like that. An `overlay` reads two pads and they are not
// interchangeable, an `amix` reads as many as it was told to, a `split` writes
// several; none of those can be described by naming a wire. So this file holds
// three more things, and each of them is written in a vocabulary that survives
// the rebuild:
//
// - `nodes` — a filter that is not on any wire. Placed on the canvas, wired
//   afterwards, and identified by an id from the same counter the inserts use.
//   An input the graph reads and a **named output** are in the same list and
//   carry a `kind`: they are not filters, but they are the same kind of thing
//   to this file — something a person placed, held by an id that survives the
//   rebuild.
// - `wires` — a connection somebody drew, as two **keys and two pad numbers**.
//   A key is what `model.js`'s `keyOf` answers: a derived node's anchor, a user
//   node's id. That is the only string that means the same thing before and
//   after a derivation, which is why an endpoint is written as one and not as a
//   node.
// - `cuts` — a derived wire somebody took *off*. Recorded rather than inferred,
//   because the skeleton grows it back on every rebuild: a graph where the
//   composite no longer feeds the sink is a state you have to be able to be in
//   while you wire something in between, and "there is no wire here" is not
//   something the absence of data can say.
//
// **It is not itself the document, and it is now part of one.** This file holds
// the live state and two persistences of it: `localStorage`, which is the
// workspace — one key, one machine, whatever was last on the screen — and a
// document, which is an edit somebody named and saved (`ui/document.js`).
// `restore()` and `adopt()` are the two reads and they differ in exactly one
// place, which is the whole reason the document was worth building: a node
// naming an input can only come back if the inputs come back with it.
// `retain()` is what keeps the workspace copy from accumulating forever.

const KEY = 'ffmpeg-bro.graph';

/// `inserts` is ordered: several nodes at one insert point are spliced in in
/// the order they were added, which is the order they will run in.
///
/// `sizes` and `pins` are how you have arranged the picture — how wide a card was
/// dragged and where it was dropped — keyed the same way a selection is. They are
/// here rather than beside the view because they are things a person set and
/// expects to find again, which is what everything in this file is. But they are
/// deliberately *not* part of `isEmpty()`: how big you like looking at a node, and
/// where you like it, have nothing to do with which of the renderer's two paths
/// the render takes, and a card nudged sideways must not change what comes out.
let state = { inserts: [], nodes: [], wires: [], cuts: [], locks: {}, sizes: {}, pins: {} };

/// Ids that are stable across a rebuild, and that cannot collide with the
/// derivation's — it hands out `n1`, `n2`… from a counter that starts fresh
/// with every graph, and "is this the same node" has to have one answer.
let seq = 0;

const listeners = [];

export function current() { return state; }
export function inserts() { return state.inserts; }
export function nodes() { return state.nodes; }
export function wires() { return state.wires; }
export function cuts() { return state.cuts; }
export function locks() { return state.locks; }
/// Whether the render goes through the compositor or through libavfilter. Every
/// piece of *structure* counts and no piece of arrangement does — a cut wire
/// with nothing put in its place still changes the graph, and a card dragged
/// three pixels still does not.
export function isEmpty() {
    return !state.inserts.length && !state.nodes.length && !state.wires.length &&
           !state.cuts.length && !Object.keys(state.locks).length;
}
export function lockCount() { return Object.keys(state.locks).length; }
export function insertCount() { return state.inserts.length; }
export function nodeCount() { return state.nodes.length; }
export function wireCount() { return state.wires.length + state.cuts.length; }

export function onChange(fn) {
    listeners.push(fn);
    return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
    };
}

function changed(what) {
    remember();
    for (const fn of listeners.slice()) fn(what);
}

/// Splice a filter in at a named point. Returns the record, whose `id` is what
/// the node built from it will carry — so a panel that has just inserted
/// something can select it, and still find it after the next rebuild.
export function insert(anchor, filter, opts = {}) {
    const rec = {
        id: `u${++seq}`,
        anchor,
        filter,
        pos: (opts.pos || []).slice(),
        params: Object.assign({}, opts.params),
    };
    state.inserts.push(rec);
    changed('insert');
    return rec;
}

/// A filter that is not on any wire.
///
/// Everything with more than one input needs this, which is most of what
/// libavfilter has: there is no wire an `overlay` could be spliced onto, because
/// splicing means one in and one out. So it is placed and then wired, which is
/// the gesture every node editor has and the one this stage was missing.
///
/// It arrives unwired on purpose. A node that guessed at its own connections
/// would be wrong about `overlay`'s two inputs half the time, and being wrong
/// about those is a picture rather than an error.
export function addNode(filter, opts = {}) {
    const rec = {
        id: `u${++seq}`,
        filter,
        pos: (opts.pos || []).slice(),
        params: Object.assign({}, opts.params),
    };
    state.nodes.push(rec);
    changed('node');
    return rec;
}

/// One of the document's inputs, read by the graph rather than by a clip.
///
/// This is how a watermark, a logo bug and a second angle are made, and it is
/// deliberately not a `movie` filter — see the long argument in `derive.js`. In
/// short: a `movie` node carries a filename and nothing else, while an input
/// carries the demuxer, the option bag, `-loop`, `-ss` and `-t`, is probed with
/// all of them in force, and already has a row on the Sources stage saying the
/// render opens it.
///
/// Held by the input's **id** rather than by its index, because the index is the
/// `-i` number and shifts when anything above it in the list is removed — the
/// same reason a derived node is held by its anchor and not by its position.
export function addSource(inputId) {
    const rec = { id: `u${++seq}`, kind: 'input', input: String(inputId) };
    state.nodes.push(rec);
    changed('node');
    return rec;
}

/// Which of the document's inputs the graph reads on its own account, by id.
/// Asked by the Sources stage, so that "every file this render opens" stays a
/// true statement once a file can be opened by the graph and by nothing else.
export function sourceInputs() {
    return state.nodes.filter((n) => n.kind === 'input').map((n) => n.input);
}

/// A named output pad — a place in the graph a stream on the Write stage can be
/// fed from.
///
/// **It is a `sink`, and reusing that kind is the point.** The derivation's two
/// ends are sinks already, so every card, wire, layout and preview on this stage
/// knows what one is; a third kind of node would have meant teaching all of them
/// the same thing again. What is different is the `name`, which becomes the pad
/// label the chain feeding it is printed with — and `pad:<label>` on a stream row
/// is what reads it.
///
/// **The stream comes from the first wire.** Placing a pad says nothing about
/// whether it is a picture or a sound; wiring one says everything. Once it is
/// set it stays, which is what makes a sound dropped into a picture output a
/// mismatch the checker can name rather than a silent change of kind.
export function addOutput(stream, name) {
    const rec = { id: `u${++seq}`, kind: 'sink',
                  name: name === undefined ? freeOutputName() : String(name),
                  stream: stream === 'a' ? 'a' : stream === 'v' ? 'v' : '' };
    state.nodes.push(rec);
    changed('node');
    return rec;
}

/// The outputs somebody has placed, in the order they were made.
export function outputs() { return state.nodes.filter((n) => n.kind === 'sink'); }

/// `out2`, `out3`… — the first one nothing is called.
///
/// Not `out1`: `vout` and `aout` are the derivation's own names for the
/// composite and the mix, so the first output anybody adds is the second thing
/// this render writes and saying so is cheaper than explaining it.
export function freeOutputName() {
    const taken = new Set(outputs().map((n) => n.name));
    for (let i = 2; ; i++) if (!taken.has(`out${i}`)) return `out${i}`;
}

/// Rename one. The rows on the Write stage that are fed from it move with it —
/// see `renamePad` in `export/pads.js`, which is where that half lives, because
/// nothing in this file knows what a stream is.
export function renameOutput(id, name) {
    const rec = state.nodes.find((n) => n.id === id && n.kind === 'sink');
    if (!rec || rec.name === String(name)) return false;
    rec.name = String(name);
    changed('node');
    return true;
}

/// Take a node out, whichever kind it is — and every wire that touched it.
///
/// Both kinds through one call because from the outside there is one gesture:
/// select a node you made, press Delete. Leaving the wires behind would leave
/// endpoints naming a node that is not in the graph, which is a state the
/// overlay is deliberately tolerant of — a clip out of range does exactly that —
/// so they would never be cleaned up and would come back the moment an id was
/// reused.
export function removeInsert(id) {
    let any = false;
    for (const list of [state.inserts, state.nodes]) {
        const i = list.findIndex((n) => n.id === id);
        if (i >= 0) { list.splice(i, 1); any = true; }
    }
    if (!any) return false;
    for (let i = state.wires.length - 1; i >= 0; i--)
        if (state.wires[i].from === id || state.wires[i].to === id) state.wires.splice(i, 1);
    forget(id);
    changed('remove');
    return true;
}

/// Everything keyed by a node that has gone, other than the node itself.
///
/// Three places lose a node — `removeInsert`, `retain` dropping a source whose
/// input is gone, and `restore` dropping an input node it will not put back —
/// and each of them used to remember a different subset of this. What is left
/// behind is not merely waste: `pins` and `sizes` are keyed by the node's id
/// and the counter hands ids out again, so a filter spliced in afterwards
/// arrives at a width and a position nobody gave it, and the blob grows for
/// ever, which is what `retain()` exists to prevent.
function forget(id) {
    // A node can itself carry insert points — an input the graph reads has one
    // per pad — so losing it has to take what was spliced onto them. Left
    // behind, those records name a point no derivation will ever declare again.
    for (let i = state.inserts.length - 1; i >= 0; i--)
        if (String(state.inserts[i].anchor).indexOf(`${id}/`) === 0)
            state.inserts.splice(i, 1);
    delete state.sizes[id];
    delete state.pins[id];
}

// ── wires ──────────────────────────────────────────────────────────────────
//
// A wire is written as the two pads it joins, and a pad is a key and a number.
// Nothing here refers to a node object or to a position in an array, because
// both of those are remade by the next derivation — see `keyOf` in model.js.
//
// **An input pad holds one wire**, which is true of libavfilter and of every
// node editor. That is what makes `wire()` able to replace the derived
// connection without anybody deleting it first, and it is what lets a wire be
// named by its arriving end alone.

const padKey = (key, port) => `${key}#${port || 0}`;

/// Join two pads. Replaces whatever was arriving at the destination — including
/// a derived wire, which is how a filter gets *between* two derived nodes.
///
/// `stream` is what the wire carries, and it is only ever used for one thing: a
/// named output that has no kind yet takes the kind of the first thing wired
/// into it. Optional because every other destination in this file already knows
/// what its pads are — an `overlay` reads pictures whoever wires it — and
/// passing it everywhere would be ceremony around the one case that needs it.
export function wire(from, fromPort, to, port, stream) {
    if (!from || !to) return null;
    const rec = { id: `w${++seq}`, from, fromPort: fromPort || 0, to, port: port || 0 };
    for (let i = state.wires.length - 1; i >= 0; i--)
        if (state.wires[i].to === rec.to && state.wires[i].port === rec.port)
            state.wires.splice(i, 1);
    if (stream === 'v' || stream === 'a') {
        const out = state.nodes.find((n) => n.id === to && n.kind === 'sink');
        if (out && !out.stream) out.stream = stream;
    }
    // A pad being wired is a pad that is no longer cut. The two are the same
    // statement about the same place and holding both would make the order they
    // are applied in decide the answer.
    const cut = state.cuts.indexOf(padKey(to, port));
    if (cut >= 0) state.cuts.splice(cut, 1);
    state.wires.push(rec);
    changed('wire');
    return rec;
}

/// Take the wire off a pad, whether it was yours or the derivation's.
///
/// A wire of your own is simply forgotten. A derived one has to be *remembered*
/// as absent, because the skeleton grows it back on every rebuild and nothing
/// missing from this file can say "not that one".
export function unwire(to, port) {
    const key = padKey(to, port);
    const i = state.wires.findIndex((w) => w.to === to && w.port === (port || 0));
    if (i >= 0) {
        state.wires.splice(i, 1);
        changed('wire');
        return true;
    }
    if (state.cuts.indexOf(key) >= 0) return false;
    state.cuts.push(key);
    changed('wire');
    return true;
}

/// Give a pad back to the derivation: forget both the wire and the cut on it.
export function reconnect(to, port) {
    const before = state.wires.length + state.cuts.length;
    for (let i = state.wires.length - 1; i >= 0; i--)
        if (state.wires[i].to === to && state.wires[i].port === (port || 0))
            state.wires.splice(i, 1);
    const cut = state.cuts.indexOf(padKey(to, port));
    if (cut >= 0) state.cuts.splice(cut, 1);
    if (state.wires.length + state.cuts.length === before) return false;
    changed('wire');
    return true;
}

export function isCut(to, port) { return state.cuts.indexOf(padKey(to, port)) >= 0; }

/// Change what a node is configured with, whichever kind it is.
///
/// One call for both because from the panel's side it is one gesture: you type
/// in a field. Where the value goes differs — a user node keeps its own params,
/// a derived one gets a lock recorded against its anchor — and that difference
/// is this function's whole job. A blank value removes the entry rather than
/// storing an empty string: `scale=w=` is a parse error, and on a derived node
/// clearing the field means "stop overriding this", which is the answer a person
/// emptying a box is asking for.
export function edit(node, change) {
    if (!node) return null;
    const target = node.derived
        ? (state.locks[node.anchor] || (state.locks[node.anchor] = { params: {}, pos: null }))
        : state.inserts.find((n) => n.id === node.id) ||
          state.nodes.find((n) => n.id === node.id);
    if (!target) return null;

    if (change.params) {
        for (const k of Object.keys(change.params)) {
            const v = change.params[k];
            if (v === '' || v === null || v === undefined) delete target.params[k];
            else target.params[k] = String(v);
        }
    }
    if (change.pos) target.pos = change.pos.map(String);

    // A lock with nothing left in it is not a lock. Left behind it would keep
    // the node badged and the spine counting it, which is a claim about an
    // override that is no longer there.
    if (node.derived && !Object.keys(target.params).length && !(target.pos || []).length)
        delete state.locks[node.anchor];

    changed('params');
    return target;
}

export function isLocked(anchor) { return !!state.locks[anchor]; }

/// Hand a node back to the derivation.
export function unlock(anchor) {
    if (!state.locks[anchor]) return false;
    delete state.locks[anchor];
    changed('lock');
    return true;
}

/// Everything a person put *into* the graph. Card sizes and positions stay: they
/// are how you like looking at it, not part of it, and throwing them away with
/// the filters would be a second surprise on top of an intended one.
///
/// **The ones held by a node of yours do not**, and that is the same rule
/// `forget()` follows one function up. A pin held by an anchor names a node the
/// next derivation makes again; a pin held by `u<n>` names something this call
/// has just thrown away, whose id is never handed out again — so it is not an
/// arrangement that has been kept, it is the blob growing on every Clear.
export function clear() {
    const keep = (from) => {
        const out = {};
        for (const k of Object.keys(from)) if (!/^u\d+$/.test(k)) out[k] = from[k];
        return out;
    };
    state = { inserts: [], nodes: [], wires: [], cuts: [], locks: {},
              sizes: keep(state.sizes), pins: keep(state.pins) };
    changed('clear');
}

// ── how the picture is arranged ────────────────────────────────────────────
//
// Two things, and neither is part of the graph: how wide a card was dragged, and
// where it was dropped. Both keyed by anchor, so they survive the skeleton being
// rebuilt on the next timeline edit — which is the whole reason they are in this
// file and not in the view.

export function sizeOf(key) { return (key && state.sizes[key]) || 0; }

export function setSize(key, width) {
    if (!key) return;
    const w = Math.round(width);
    if (!(w > 0)) delete state.sizes[key];
    else state.sizes[key] = w;
    changed('size');
}

/// Where a node was dropped, in graph coordinates, or null for "wherever the
/// layout puts it". Null rather than a default, because "not pinned" and "pinned
/// at 0,0" are different states and only one of them follows the layout.
export function pinOf(key) {
    const p = key ? state.pins[key] : null;
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
}

export function setPin(key, x, y) {
    if (!key) return;
    state.pins[key] = { x: Math.round(x), y: Math.round(y) };
    changed('pin');
}

export function pinCount() { return Object.keys(state.pins).length; }

/// Give the whole graph back to the layout.
export function unpinAll() {
    if (!Object.keys(state.pins).length) return false;
    state.pins = {};
    changed('pin');
    return true;
}

/// Everything pinned to one clip, copied onto another.
///
/// A split makes a second clip out of one, and a cut should not change how
/// either half looks — so both halves keep the filters the whole had. Called
/// from the split rather than inferred here, because nothing in this file knows
/// what a clip is.
///
/// **Pins are not copied**, and that is the one thing here that is not symmetric.
/// A filter applies to both halves; a *position* cannot, because two cards cannot
/// be in one place and copying it would drop the new clip's whole chain exactly on
/// top of the old one's. The new half is laid out, which is where an unpinned node
/// belongs.
///
/// **Nor are wires**, for a stronger reason than tidiness. A wire is one
/// connection between two named pads, and an input pad holds exactly one wire —
/// so a copy of a wire that ends at some node of yours would be a second
/// producer arriving at a pad that already has one, which is not a graph. The
/// derivation builds the new half's chain complete on its own; what a cut does
/// not carry over is the hand wiring, and that is a thing to say rather than a
/// thing to guess at.
export function cloneClip(fromId, toId) {
    const from = `clip:${fromId}`, to = `clip:${toId}`;
    const swap = (a) => (a.indexOf(`${from}/`) === 0 ? to + a.slice(from.length) : null);
    let any = false;
    for (const rec of state.inserts.slice()) {
        const anchor = swap(rec.anchor);
        if (!anchor) continue;
        state.inserts.push({ id: `u${++seq}`, anchor, filter: rec.filter,
                             pos: rec.pos.slice(), params: Object.assign({}, rec.params) });
        any = true;
    }
    for (const anchor of Object.keys(state.locks)) {
        const to2 = swap(anchor) ||
                    (anchor === `composite/overlay:${fromId}` ? `composite/overlay:${toId}` : null);
        if (!to2) continue;
        const l = state.locks[anchor];
        state.locks[to2] = { params: Object.assign({}, l.params), pos: l.pos ? l.pos.slice() : null };
        any = true;
    }
    if (any) changed('clone');
}

/// Drop everything pinned to a clip that is no longer open.
///
/// Called on every model change rather than from each place a clip can go
/// away, because there are several — delete, a batch drop that clears the
/// timeline, a project reset — and an overlay that grows every time one of them
/// is missed is a localStorage blob that eventually costs a startup.
export function retain(clipIds, inputIds) {
    const live = new Set(Array.from(clipIds, String));
    const gone = (anchor) => {
        const m = /^clip:([^/]+)\//.exec(anchor) || /^composite\/overlay:(.+)$/.exec(anchor);
        return !!m && !live.has(m[1]);
    };
    let any = false;
    for (let i = state.inserts.length - 1; i >= 0; i--)
        if (gone(state.inserts[i].anchor)) { state.inserts.splice(i, 1); any = true; }
    for (const anchor of Object.keys(state.locks))
        if (gone(anchor)) { delete state.locks[anchor]; any = true; }
    // A wire with an end on a clip that has gone. Both ends are checked because
    // either can be a derived node: a hand-made `overlay` fed by two clips loses
    // its wire when either of them does, and keeping half of it would leave a
    // pad claiming a producer that no derivation will ever make again.
    for (let i = state.wires.length - 1; i >= 0; i--) {
        const w = state.wires[i];
        if (gone(w.from) || gone(w.to)) { state.wires.splice(i, 1); any = true; }
    }
    for (let i = state.cuts.length - 1; i >= 0; i--)
        if (gone(String(state.cuts[i]).split('#')[0])) { state.cuts.splice(i, 1); any = true; }
    for (const key of Object.keys(state.sizes))
        if (gone(key)) { delete state.sizes[key]; any = true; }
    for (const key of Object.keys(state.pins))
        if (gone(key)) { delete state.pins[key]; any = true; }
    // A source node whose input has been taken off the Sources stage. Removed
    // rather than kept, which is the opposite of the rule for a clip out of
    // range, and for a reason: a clip out of range comes back when the range
    // moves, whereas a removed input is gone and the id will never be handed out
    // again. Only checked when the caller says what the live inputs are, so that
    // a call made before the input list exists cannot empty the graph.
    if (inputIds) {
        const liveIn = new Set(Array.from(inputIds, String));
        for (let i = state.nodes.length - 1; i >= 0; i--) {
            const rec = state.nodes[i];
            if (rec.kind !== 'input' || liveIn.has(String(rec.input))) continue;
            state.nodes.splice(i, 1);
            for (let j = state.wires.length - 1; j >= 0; j--)
                if (state.wires[j].from === rec.id || state.wires[j].to === rec.id)
                    state.wires.splice(j, 1);
            forget(rec.id);
            any = true;
        }
    }
    if (any) changed('retain');
}

// ── persistence ────────────────────────────────────────────────────────────

/// One filter record — an insert or a free node — validated rather than
/// trusted. What is in localStorage was written by some earlier version of this
/// application, and a record missing the field everything else indexes it by is
/// a redraw that throws.
function filterRec(n, withAnchor) {
    if (!n || !n.id || (withAnchor && !n.anchor)) return null;
    // An input the graph reads is in the same list and has no filter name to be
    // validated by: what it *is* is the input it names, and an id that no longer
    // matches one is handled where the graph is derived rather than here — a
    // removed input can be added again, and the node should come back with it.
    if (!withAnchor && n.kind === 'input')
        return n.input ? { id: String(n.id), kind: 'input', input: String(n.input) } : null;
    // A named output has no filter name either, and unlike an input it *is*
    // written back out: it names nothing outside this file — the label is its
    // own — so restoring one cannot come to mean a different thing next run.
    // A name that has been cleared is kept as the empty string it is, because
    // an output with no name is a graph with a problem in it and dropping the
    // field would quietly turn it into the render's own sink.
    if (!withAnchor && n.kind === 'sink')
        return { id: String(n.id), kind: 'sink', name: String(n.name || ''),
                 stream: n.stream === 'a' ? 'a' : n.stream === 'v' ? 'v' : '' };
    if (!n.filter) return null;
    const rec = { id: String(n.id), filter: String(n.filter),
                  pos: Array.isArray(n.pos) ? n.pos.map(String) : [],
                  params: Object.assign({}, n.params) };
    if (withAnchor) rec.anchor = String(n.anchor);
    return rec;
}

/// What the workspace was left holding.
export function restore() {
    try {
        const saved = localStorage.getItem(KEY);
        if (saved) load(JSON.parse(saved), false);
    } catch (e) { /* first run, or a blob from an older shape */ }
}

/// The same read, from a document rather than from `localStorage` — **and with
/// the input nodes kept**.
///
/// That is the whole difference between the two callers and it is not a
/// preference. A blob out of `localStorage` arrives beside a fresh input list
/// whose ids start again from one, so a restored `in3` would name whichever file
/// happened to be third this run. A document restores its own inputs, by their
/// own ids, before it gets here — see `ui/document.js` — so `in3` means the file
/// it meant when the document was written. Same data, two different answers to
/// what an id refers to.
///
/// Announces itself, unlike `restore()`: this happens while the application is
/// running and everything downstream of the graph has to be told. `restore()`
/// runs before anything has asked for a graph at all, and would only be telling
/// listeners about the state they are about to read anyway.
export function adopt(blob) {
    load(blob && typeof blob === 'object' ? blob : {}, true);
    changed('adopt');
}

/// The read both of them are.
///
/// **A blob written before there were free nodes still loads**, and loads as
/// exactly what it was: three keys it has never heard of come back empty, and an
/// overlay of inserts and locks behaves the way it always did. The shape grew
/// rather than changing, which is what makes that possible and is worth the
/// restraint it cost — the alternative was a version number and a migration for
/// work somebody had done and could not get back.
///
/// `keepInputs` is the one thing the two callers disagree about; see `adopt`.
function load(blob, keepInputs) {
    const list = (v, withAnchor) => (Array.isArray(v) ? v : [])
        .map((n) => filterRec(n, withAnchor)).filter(Boolean);
    // **A node naming one of the document's inputs is dropped unless the caller
    // is bringing those inputs with it.** A restored `in3` beside a fresh input
    // list would name whichever file happened to be third this run, which is
    // worse than losing the node: it is a graph that quietly reads a different
    // file.
    const dropped = new Set();
    const nodes = list(blob.nodes, false).filter((n) => {
        if (n.kind !== 'input' || keepInputs) return true;
        dropped.add(n.id);
        return false;
    });
    state = {
        inserts: list(blob.inserts, true),
        nodes,
        wires: (Array.isArray(blob.wires) ? blob.wires : [])
            .filter((w) => w && w.id && w.from && w.to &&
                           !dropped.has(String(w.from)) && !dropped.has(String(w.to)))
            .map((w) => ({ id: String(w.id), from: String(w.from),
                           fromPort: Number(w.fromPort) || 0,
                           to: String(w.to), port: Number(w.port) || 0 })),
        cuts: (Array.isArray(blob.cuts) ? blob.cuts : []).map(String),
        locks: (blob.locks && typeof blob.locks === 'object') ? blob.locks : {},
        sizes: (blob.sizes && typeof blob.sizes === 'object') ? blob.sizes : {},
        pins: (blob.pins && typeof blob.pins === 'object') ? blob.pins : {},
    };
    // Ids handed back to us must not be handed out again. Wires are counted
    // out of the same sequence as nodes, so that no two things in this file
    // can ever be told apart by their id alone and then turn out not to be
    // — and **the ids just dropped count too**, because they are still
    // written all over the blob even though the nodes are not coming back.
    const ids = state.inserts.concat(state.nodes, state.wires).map((r) => r.id)
                    .concat(Array.from(dropped));
    for (const id of ids) {
        const m = /^[uw](\d+)$/.exec(id);
        if (m) seq = Math.max(seq, Number(m[1]));
    }
    // ...and what those nodes were arranged with goes with them. So does
    // anything left over by an older version that dropped a node without
    // it: a user node's id is `u<n>` and nothing else here is shaped like
    // one — every anchor carries a `/` or a `:` — so a key of that shape
    // naming no record is a node that is gone, and the blob on disk has
    // been through this already.
    for (const id of Array.from(dropped)) forget(id);
    const known = new Set(state.inserts.concat(state.nodes).map((r) => r.id));
    for (const bag of [state.sizes, state.pins])
        for (const key of Object.keys(bag))
            if (/^u\d+$/.test(key) && !known.has(key)) delete bag[key];
}

/// The workspace copy: **the whole state, including the input nodes `restore()`
/// will refuse to put back.** That looks like waste and is not: those records
/// are the only surviving evidence of which ids were handed out, and the read
/// uses them for exactly that — it scans them into `seq` so a node made next run
/// cannot be issued an id
/// the blob still mentions, and it uses them to find the `pins` and `sizes` that
/// belonged to them and delete those too. Write only what comes back and the
/// reader loses the list it cleans up from. See the note beside the `dropped` set.
export function remember() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { /* not fatal: the graph still runs, it just will not be there next time */ }
}
