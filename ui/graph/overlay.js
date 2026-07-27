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
// **It is not a project file.** There is no project file yet; this is the first
// thing that makes one worth having. Until then it goes in localStorage
// alongside the export settings, which means it is remembered per machine
// rather than per edit — and which is exactly why `retain()` exists, so nodes
// pinned to clips that are no longer open do not accumulate forever.

const KEY = 'ffmpeg-bro.graph';

/// `inserts` is ordered: several nodes at one insert point are spliced in in
/// the order they were added, which is the order they will run in.
/// `sizes` is how wide each node's card was dragged to, keyed the same way a
/// selection is. It is here rather than beside the view because it is a thing a
/// person set and expects to find again, which is what everything in this file
/// is — but it is deliberately *not* part of `isEmpty()`: how big you like
/// looking at a node has nothing to do with which of the renderer's two paths
/// the render takes.
let state = { inserts: [], locks: {}, sizes: {} };

/// Ids that are stable across a rebuild, and that cannot collide with the
/// derivation's — it hands out `n1`, `n2`… from a counter that starts fresh
/// with every graph, and "is this the same node" has to have one answer.
let seq = 0;

const listeners = [];

export function current() { return state; }
export function inserts() { return state.inserts; }
export function locks() { return state.locks; }
export function isEmpty() {
    return !state.inserts.length && !Object.keys(state.locks).length;
}
export function lockCount() { return Object.keys(state.locks).length; }
export function insertCount() { return state.inserts.length; }

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

export function removeInsert(id) {
    const i = state.inserts.findIndex((n) => n.id === id);
    if (i < 0) return false;
    state.inserts.splice(i, 1);
    changed('remove');
    return true;
}

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
        : state.inserts.find((n) => n.id === node.id);
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

/// Everything a person put *into* the graph. Card widths stay: they are how
/// you like looking at it, not part of it, and throwing them away with the
/// filters would be a second surprise on top of an intended one.
export function clear() {
    state = { inserts: [], locks: {}, sizes: state.sizes };
    changed('clear');
}

// ── how big each card is ───────────────────────────────────────────────────

export function sizeOf(key) { return (key && state.sizes[key]) || 0; }

export function setSize(key, width) {
    if (!key) return;
    const w = Math.round(width);
    if (!(w > 0)) delete state.sizes[key];
    else state.sizes[key] = w;
    changed('size');
}

/// Everything pinned to one clip, copied onto another.
///
/// A split makes a second clip out of one, and a cut should not change how
/// either half looks — so both halves keep the filters the whole had. Called
/// from the split rather than inferred here, because nothing in this file knows
/// what a clip is.
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
export function retain(clipIds) {
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
    for (const key of Object.keys(state.sizes))
        if (gone(key)) { delete state.sizes[key]; any = true; }
    if (any) changed('retain');
}

// ── persistence ────────────────────────────────────────────────────────────

export function restore() {
    try {
        const saved = localStorage.getItem(KEY);
        if (!saved) return;
        const blob = JSON.parse(saved);
        state = {
            inserts: Array.isArray(blob.inserts)
                ? blob.inserts.filter((n) => n && n.id && n.anchor && n.filter)
                              .map((n) => ({ id: String(n.id), anchor: String(n.anchor),
                                             filter: String(n.filter),
                                             pos: Array.isArray(n.pos) ? n.pos.map(String) : [],
                                             params: Object.assign({}, n.params) }))
                : [],
            locks: (blob.locks && typeof blob.locks === 'object') ? blob.locks : {},
            sizes: (blob.sizes && typeof blob.sizes === 'object') ? blob.sizes : {},
        };
        // Ids handed back to us must not be handed out again.
        for (const rec of state.inserts) {
            const m = /^u(\d+)$/.exec(rec.id);
            if (m) seq = Math.max(seq, Number(m[1]));
        }
    } catch (e) { /* first run, or a blob from an older shape */ }
}

export function remember() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { /* not fatal: the graph still runs, it just will not be there next time */ }
}
