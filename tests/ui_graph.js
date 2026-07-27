// The graph model itself, below the string it prints.
//
// `tests/ui_filtergraph.js` watches the same code from outside — it hands a
// spec in and compares chains as strings, which is the right check for the
// translation and is what proved the restructure changed nothing. It cannot see
// any of what is here: a graph is now a thing that is held and changed, and
// locks, insertion, removal and round-tripping through localStorage are
// behaviour with no printed form.
//
// The printer is checked here on graphs built by hand, because the derivation
// only ever produces one shape and the chain rule has to be right for shapes it
// does not produce yet.
//
// Usage: ffmpeg-bro-headless ui/ tests/ui_graph.js
//        (no media file — nothing here decodes anything)

function pump(ms) {
    const steps = Math.max(1, Math.ceil(ms / 20));
    for (let i = 0; i < steps; i++) { wallSleep(20); advanceTime(20); flush(); }
}

function waitFor(what, predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        pump(40);
    }
    assert(false, `timed out waiting for ${what}`);
    return false;
}

let checks = 0;
function ok(cond, what) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`);
    assert(cond, what);
}

function same(actual, expected, what) {
    if (actual !== expected) {
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
    }
    ok(actual === expected, what);
}

waitFor('app.js to finish', () => globalThis.__ffmpegBroReady);
const { makeGraph, restore, derive, print } = globalThis.__ffmpegBro.graph;
ok(typeof makeGraph === 'function', 'the graph model is on the test surface');

// ── nodes and wires ────────────────────────────────────────────────────────

console.log('\nnodes and wires');
{
    const g = makeGraph();
    const a = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const b = g.add({ filter: 'hflip' });
    g.connect(a, b, 0);

    ok(a.id !== b.id, 'every node gets its own id');
    same(g.node(b.id), b, 'a node can be found by id');
    same(g.producers(b).length, 1, 'and by what feeds it');
    same(g.consumers(a)[0], b, 'and by what it feeds');
    same(b.derived, false, 'a node is a user node unless the graph says otherwise');
    same(makeGraph({ derived: true }).add({ filter: 'null' }).derived, true,
         'a derived graph marks what it builds');
}

console.log('\nports');
{
    // overlay's first input is what it draws onto and its second is what it
    // draws. Wired the wrong way round that is a picture, not an error — so
    // producers() answers in port order however the edges were made.
    const g = makeGraph();
    const under = g.add({ filter: 'color', label: 'base' });
    const over = g.add({ filter: 'format', label: 'v0' });
    const o = g.add({ filter: 'overlay' });
    g.connect(over, o, 1);
    g.connect(under, o, 0);
    same(g.producers(o).map((p) => p.label).join(','), 'base,v0',
         'edges made out of order still read in port order');
}

console.log('\nruns');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const last = g.run(src, [{ filter: 'hflip' }, { filter: 'vflip' }], 'out');
    same(last.filter, 'vflip', 'a run returns its last node');
    same(last.label, 'out', 'which is the only one that gets the label');
    same(g.nodes.length, 3, 'and every step became a node');
    same(g.producers(last)[0].filter, 'hflip', 'wired in order');
}

// ── printing ───────────────────────────────────────────────────────────────
//
// The chain rule: a run continues while the wire is private. Everything below
// is a way for a wire to stop being private.

console.log('\narguments');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const cropped = g.run(src, [{ filter: 'crop', pos: ['iw/2', 'ih'], params: { x: '0', y: '0' } }], 'out');
    g.connect(cropped, g.add({ kind: 'sink', stream: 'v' }), 0);
    same(print(g).chains[0], '[0:v]crop=iw/2:ih:x=0:y=0[out]',
         'positional arguments first, then named');

    const bare = makeGraph();
    const bsrc = bare.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    bare.run(bsrc, [{ filter: 'null' }], 'out');
    same(print(bare).chains[0], '[0:v]null[out]',
         'a filter with no arguments is written bare — `null=` is a parse error');
}

console.log('\na private wire is joined');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const out = g.run(src, [{ filter: 'hflip' }, { filter: 'vflip' }, { filter: 'negate' }], 'out');
    g.connect(out, g.add({ kind: 'sink', stream: 'v' }), 0);
    const p = print(g);
    same(p.chains.length, 1, 'three filters in a row are one chain');
    same(p.chains[0], '[0:v]hflip,vflip,negate[out]', 'joined by commas, named once');
    same(p.video, '[out]', 'and the sink reports the pad it maps');
}

console.log('\na wire read by a filter with two inputs is named');
{
    const g = makeGraph();
    const a = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const b = g.add({ kind: 'input', stream: 'v', index: 1, path: 'b.mp4' });
    const left = g.run(a, [{ filter: 'hflip' }], 'l');
    const right = g.run(b, [{ filter: 'vflip' }], 'r');
    const out = g.run([left, right], [{ filter: 'overlay' }, { filter: 'format', pos: ['yuv420p'] }], 'out');
    g.connect(out, g.add({ kind: 'sink', stream: 'v' }), 0);

    const p = print(g);
    same(p.chains.length, 3, 'two feeds and the chain they meet in');
    same(p.chains[0], '[0:v]hflip[l]', 'each feed is named');
    same(p.chains[1], '[1:v]vflip[r]', 'both of them');
    same(p.chains[2], '[l][r]overlay,format=yuv420p[out]',
         'and what follows the join rides on its back — one input, one consumer');
    same(p.inputs.join(' '), 'a.mp4 b.mp4', 'the files come from the input nodes');
}

console.log('\na wire read twice is named');
{
    // Two consumers of one pad is not valid ffmpeg without a `split` — which
    // this model cannot express yet, because an edge names an input port and a
    // node has one output. The chain rule still has to break here rather than
    // print two chains that both claim to end at the same anonymous pad, and
    // when split arrives it arrives as a printer change and not a rule change.
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const fork = g.run(src, [{ filter: 'hflip' }], 'fork');
    const one = g.run(fork, [{ filter: 'negate' }], 'one');
    const two = g.run(fork, [{ filter: 'vflip' }], 'two');
    g.connect(one, g.add({ kind: 'sink', stream: 'v' }), 0);

    const p = print(g);
    same(p.chains.length, 3, 'the fork ends a chain instead of being joined into one');
    same(p.chains[0], '[0:v]hflip[fork]', 'so the pad both readers share has a name');
    same(p.chains[1], '[fork]negate[one]', 'and each reader starts its own chain');
    same(p.chains[2], '[fork]vflip[two]', 'both of them');
    ok(!!(one && two), 'both branches exist');
}

console.log('\nan unlabelled chain end still prints');
{
    // Never happens for a derived graph — derive.js labels every run it makes —
    // but a hand-built one should come out readable rather than crash.
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const out = g.run(src, [{ filter: 'hflip' }]);
    g.connect(out, g.add({ kind: 'sink', stream: 'v' }), 0);
    const p = print(g);
    ok(/^\[0:v\]hflip\[\w+\]$/.test(p.chains[0]), `a name is invented: ${p.chains[0]}`);
    same(p.video, `[${p.chains[0].match(/\[(\w+)\]$/)[1]}]`,
         'and the sink reports the same invented one, not a second one');
}

// ── editing ────────────────────────────────────────────────────────────────

console.log('\ninsertion');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const a = g.run(src, [{ filter: 'hflip' }]);
    const b = g.run(a, [{ filter: 'negate' }], 'out');
    g.connect(b, g.add({ kind: 'sink', stream: 'v' }), 0);

    const mid = g.insertAfter(a, { filter: 'eq', params: { contrast: '1.2' } });
    same(print(g).chains[0], '[0:v]hflip,eq=contrast=1.2,negate[out]',
         'a node inserted on a wire lands between its ends, not beside them');
    same(mid.derived, false, 'and is a user node, whatever graph it went into');
}

console.log('\nremoval heals the wire');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const a = g.run(src, [{ filter: 'hflip' }]);
    const mid = g.run(a, [{ filter: 'negate' }]);
    const b = g.run(mid, [{ filter: 'vflip' }], 'out');
    g.connect(b, g.add({ kind: 'sink', stream: 'v' }), 0);

    ok(g.remove(mid), 'a node can be taken out');
    same(print(g).chains[0], '[0:v]hflip,vflip[out]',
         'and what it sat between is joined up — removing a node must not cut the graph in two');
    same(g.remove('nosuchnode'), false, 'removing what is not there is not an error');
}

console.log('\nlocks');
{
    const g = makeGraph({ derived: true });
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const node = g.run(src, [{ filter: 'scale', pos: ['640', '360'] }], 'out');
    same(node.locked, false, 'a derived node starts unlocked');

    g.setParams(node, { flags: 'lanczos' });
    same(node.locked, true, 'editing a param locks the node it was edited on');
    same(node.params.flags, 'lanczos', 'and the value is kept');
    ok(node.derived, 'it is still a derived node — locked, not adopted');

    g.setLocked(node, false);
    same(node.locked, false, 'and it can be handed back to the derivation');
}

console.log('\nchange events');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const node = g.run(src, [{ filter: 'hflip' }], 'out');

    const seen = [];
    const off = g.onChange((what) => seen.push(what));
    same(seen.length, 0, 'building a graph is not an edit to one');

    g.setParams(node, { x: '1' });
    g.setLocked(node, false);
    g.insertAfter(node, { filter: 'negate' });
    same(seen.join(','), 'params,lock,insert', 'every edit announces what it was');

    off();
    g.setParams(node, { x: '2' });
    same(seen.length, 3, 'and a listener that unsubscribed hears nothing more');
}

// ── persistence ────────────────────────────────────────────────────────────

console.log('\nround trip');
{
    const g = makeGraph({ derived: true });
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4' });
    const node = g.run(src, [{ filter: 'scale', pos: ['640', '360'] }], 'out');
    g.setParams(node, { flags: 'lanczos' });
    const user = g.insertAfter(node, { filter: 'eq', anchor: 'clip:7/after-scale' });
    g.connect(user, g.add({ kind: 'sink', stream: 'v' }), 0);

    const json = JSON.parse(JSON.stringify(g.toJSON()));
    const back = restore(json);
    same(back.nodes.length, g.nodes.length, 'every node survives');
    same(print(back).chains[0], print(g).chains[0], 'and prints identically');

    const same7 = back.node(user.id);
    ok(!!same7, 'ids are kept, which is what lets a restored node be found again');
    same(same7.anchor, 'clip:7/after-scale', 'so is the anchor it was pinned to');
    same(back.node(node.id).locked, true, 'and the lock');

    // Ids come from a counter that starts at zero in a fresh process, and a
    // graph read back out of localStorage was numbered by a previous one.
    // Handing one of its ids out again would make "is this the same node" a
    // question with two answers.
    const old = restore({ nodes: [{ id: 'n90001', filter: 'null' }], edges: [] });
    const fresh = makeGraph().add({ filter: 'null' });
    ok(fresh.id !== 'n90001' && !old.node(fresh.id),
       `a restore takes its ids out of circulation (${fresh.id})`);

    // The skeleton is derived from the timeline every time it changes, so
    // writing it down would persist a picture of the edit as it was rather
    // than one of the edit as it is.
    const persisted = g.userNodes();
    ok(persisted.indexOf(user) >= 0, 'a node a person made is worth writing down');
    ok(persisted.indexOf(node) >= 0, 'so is a derived one they locked');
    ok(persisted.indexOf(g.nodes[0]) < 0, 'the rest of the skeleton is not');
}

// ── the derivation, as a graph rather than as a string ─────────────────────

console.log('\nwhat derive() builds');
{
    const clip = (over) => Object.assign({
        path: 'a.mp4', start: 0, length: 4, inPoint: 0,
        x: 0, y: 0, w: 1920, h: 1080,
        crop: { l: 0, t: 0, r: 0, b: 0 },
        opacity: 1, volume: 1, muted: false, z: 0,
    }, over);
    const spec = {
        width: 1920, height: 1080, fps: 30, start: 0, end: 4,
        audio: true, clips: [clip({ path: 'under.mp4' }), clip({ path: 'over.mp4' })],
    };

    const d = derive(spec);
    ok(d.ok, 'a two-clip edit derives');
    const g = d.graph;

    const kinds = {};
    for (const n of g.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
    same(kinds.input, 4, 'one input node per clip per stream — two clips, video and audio');
    same(kinds.sink, 2, 'and one sink per stream the muxer maps');
    ok(g.nodes.every((n) => n.derived), 'every node the derivation makes is marked derived');
    ok(g.nodes.every((n) => !n.locked), 'and none of them is locked');

    const vsink = g.nodes.find((n) => n.kind === 'sink' && n.stream === 'v');
    same(g.producers(vsink)[0].label, 'vout', 'the video sink is fed by the pad it maps');
    const asink = g.nodes.find((n) => n.kind === 'sink' && n.stream === 'a');
    same(g.producers(asink)[0].filter, 'amix', 'and the audio sink by the mixer');

    // The refusal is the graph's, not the printer's: there is nothing to print.
    same(derive({ clips: [] }).ok, false, 'and an edit it cannot express has no graph at all');
}

// ── anchors, insert points and the user's layer ────────────────────────────
//
// The whole of step 4 rests on one thing being true: the skeleton is thrown
// away and rebuilt every time the timeline moves, and what a person did to it
// has to survive that. Everything below is a way for it not to.

const overlay = globalThis.__ffmpegBro.graph.overlay;

/// One clip, with an id — which is what makes `clip:7/scale` mean the same
/// thing before and after an edit. A spec written without one falls back to a
/// position, which is fine for a printer test and is exactly what an anchor
/// cannot be built on.
function oneClip(over) {
    return {
        width: 1920, height: 1080, fps: 30, start: 0, end: 4, audio: true,
        clips: [Object.assign({
            id: 7, path: 'a.mp4', start: 0, length: 4, inPoint: 0,
            x: 0, y: 0, w: 1920, h: 1080,
            crop: { l: 0, t: 0, r: 0, b: 0 },
            opacity: 1, volume: 1, muted: false, z: 0,
        }, over)],
    };
}

const chainFor = (d, pad) => print(d.graph).chains.find((c) => c.endsWith(`[${pad}]`));

console.log('\nevery derived node is named for what it is');
{
    const d = derive(oneClip());
    const anchors = d.graph.nodes.map((n) => n.anchor);
    ok(anchors.every(Boolean), 'no derived node is left without an anchor');
    ok(anchors.indexOf('clip:7/scale') >= 0, 'and the name is the clip and the job');
    ok(anchors.indexOf('composite/overlay:7') >= 0, 'including the one that places it');
    same(d.graph.byAnchor('clip:7/scale').pos.join(':'), '1920:1080',
         'a node can be found by that name');
    // The id comes from the clip, not from where it sits in the array — two
    // clips cut from one file are two anchors and reordering them is not an
    // edit to either.
    same(derive(oneClip({ id: 91 })).graph.byAnchor('clip:91/scale').pos.join(':'), '1920:1080',
         'the id is the clip’s own');
}

console.log('\nthe wires say where something can go');
{
    const ids = derive(oneClip()).points.map((p) => p.id).sort().join(' ');
    same(ids, 'audio/after-mix clip:7/after-decode clip:7/after-scale clip:7/audio ' +
              'composite/after-overlay',
         'five points: two per clip picture, the clip’s sound, the composite and the mix');

    // Deliberately absent. The conversion into the encoder's colour is the one
    // chain that exists in the printed graph and not in the one this
    // application runs, so a point after it would mean one insertion and two
    // different pictures.
    ok(derive(oneClip()).points.every((p) => p.id !== 'pre-encode'),
       'and none after the output colour conversion, which only the printout has');
}

console.log('\na filter put on a wire lands on that wire');
{
    const before = derive(oneClip(), null, {
        overlay: { inserts: [{ id: 'u1', anchor: 'clip:7/after-decode', filter: 'hflip',
                               pos: [], params: {} }], locks: {} },
    });
    ok(/^\[0:v\]hflip,trim=/.test(chainFor(before, 'v0')),
       `before the trim, where the decoder hands it over: ${chainFor(before, 'v0')}`);

    const after = derive(oneClip(), null, {
        overlay: { inserts: [{ id: 'u1', anchor: 'clip:7/after-scale', filter: 'hflip',
                               pos: [], params: {} }], locks: {} },
    });
    ok(/format=rgba,hflip\[v0\]$/.test(chainFor(after, 'v0')),
       `and after the scale when that is what was asked for: ${chainFor(after, 'v0')}`);
    // The label belongs to the end of the chain, not to the node that used to
    // be there. Left behind, `[v0]` would be a pad no chain produces and the
    // overlay reading it would be reading nothing.
    same(after.graph.byAnchor('clip:7/format').label, null,
         'the pad name moves to the new end of the chain');
    same(after.graph.node('u1').label, 'v0', 'which is the node that was inserted');

    const sound = derive(oneClip(), null, {
        overlay: { inserts: [{ id: 'u1', anchor: 'audio/after-mix', filter: 'loudnorm',
                               pos: [], params: {} }], locks: {} },
    });
    ok(/loudnorm\[a0\]$/.test(chainFor(sound, 'a0')),
       `sound is the same mechanism on a different stream: ${chainFor(sound, 'a0')}`);
    same(print(sound.graph).audio, '[a0]', 'and the muxer still maps the end of it');
}

console.log('\ntwo filters at one point run in the order they were added');
{
    const d = derive(oneClip(), null, {
        overlay: { inserts: [
            { id: 'u1', anchor: 'clip:7/after-decode', filter: 'hflip', pos: [], params: {} },
            { id: 'u2', anchor: 'clip:7/after-decode', filter: 'vflip', pos: [], params: {} },
        ], locks: {} },
    });
    ok(/^\[0:v\]hflip,vflip,trim=/.test(chainFor(d, 'v0')),
       `and not the other way round: ${chainFor(d, 'v0')}`);
}

console.log('\nan anchor whose clip is out of range is kept, not dropped');
{
    // A clip trimmed out of the rendered range takes its insert points with it.
    // Throwing the node away would mean shortening the range deleted work.
    const spec = oneClip();
    spec.start = 10;
    spec.end = 14;
    const ov = { inserts: [{ id: 'u1', anchor: 'clip:7/after-decode', filter: 'hflip',
                             pos: [], params: {} }], locks: {} };
    same(derive(spec, null, { overlay: ov }).ok, false,
         'nothing falls inside the range, so there is no graph');
    same(ov.inserts.length, 1, 'and the node is still there for when the clip comes back');
    ok(derive(oneClip(), null, { overlay: ov }).graph.node('u1'),
       'which it does, unchanged');
}

console.log('\na lock outranks the edit, and says that it did');
{
    const ov = { inserts: [], locks: { 'clip:7/scale': { params: {}, pos: ['320', '180'] } } };
    const d = derive(oneClip(), null, { overlay: ov });
    same(d.graph.byAnchor('clip:7/scale').pos.join(':'), '320:180', 'the typed value is used');
    ok(d.graph.byAnchor('clip:7/scale').locked, 'and the node says it is locked');
    ok(d.graph.byAnchor('clip:7/scale').derived,
       'while still being a derived node — locked, not adopted');

    same(d.overrides.length, 1, 'one override is reported');
    same(d.overrides[0].clip, '7', 'against the clip it belongs to');
    same(d.overrides[0].control, 'size', 'and the control it took over');

    // The point of the whole thing: the timeline moved and the value did not.
    const moved = derive(oneClip({ w: 640, h: 360 }), null, { overlay: ov });
    same(moved.graph.byAnchor('clip:7/scale').pos.join(':'), '320:180',
         'a timeline edit does not silently revert it');
    same(moved.overrides[0].keys.join(','), 'arguments', 'and what it outranked is named');

    // A lock that happens to agree has outranked nothing yet. Marking the
    // control anyway would put a badge on every field anyone had ever touched.
    const agrees = derive(oneClip({ w: 320, h: 180 }), null, { overlay: ov });
    ok(agrees.graph.byAnchor('clip:7/scale').locked, 'a lock that agrees is still a lock');
    same(agrees.overrides[0].keys.length, 0, 'but it has overridden nothing');
}

console.log('\nlocking a named param');
{
    const ov = { inserts: [], locks: { 'clip:7/opacity': { params: { aa: '0.25' }, pos: null } } };
    const d = derive(oneClip({ opacity: 0.8 }), null, { overlay: ov });
    ok(/colorchannelmixer=aa=0.25/.test(chainFor(d, 'v0')),
       `the value reaches the graph: ${chainFor(d, 'v0')}`);
    same(d.overrides[0].keys.join(','), 'aa', 'and the key is named');
    same(d.overrides[0].control, 'opacity', 'against the slider it outranks');
}

// ── the overlay as a thing the application holds ───────────────────────────

console.log('\nthe overlay itself');
{
    overlay.clear();
    ok(overlay.isEmpty(), 'it starts empty');

    const rec = overlay.insert('clip:3/after-scale', 'eq');
    same(overlay.insertCount(), 1, 'a filter can be put at a point');
    ok(/^u\d+$/.test(rec.id), `with an id of its own (${rec.id})`);

    // Editing a user node writes to the node; editing a derived one records a
    // lock. One call, because from the panel's side it is one gesture.
    overlay.edit({ id: rec.id, derived: false }, { params: { contrast: '1.4' } });
    same(overlay.inserts()[0].params.contrast, '1.4', 'its params are its own');

    overlay.edit({ anchor: 'clip:3/crop', derived: true }, { params: { x: '10' } });
    same(overlay.lockCount(), 1, 'editing a derived node records a lock instead');
    ok(overlay.isLocked('clip:3/crop'), 'against its anchor');

    // A blank means "stop overriding this", which is what emptying a box asks
    // for. A lock with nothing left in it is not a lock.
    overlay.edit({ anchor: 'clip:3/crop', derived: true }, { params: { x: '' } });
    same(overlay.lockCount(), 0, 'and emptying the field takes the lock away with it');
}

console.log('\na split keeps both halves looking the same');
{
    overlay.clear();
    overlay.insert('clip:3/after-scale', 'hflip');
    overlay.edit({ anchor: 'clip:3/scale', derived: true }, { pos: ['640', '360'] });
    overlay.cloneClip(3, 4);

    same(overlay.insertCount(), 2, 'the new half gets its own copy of the filter');
    same(overlay.inserts()[1].anchor, 'clip:4/after-scale', 'pinned to its own clip');
    ok(overlay.inserts()[0].id !== overlay.inserts()[1].id, 'and its own id');
    ok(overlay.isLocked('clip:4/scale'), 'the lock is copied too');
    // Copied, not shared: editing one half after the cut must not change the
    // other, which is a thing a shared reference would do quietly.
    overlay.edit({ anchor: 'clip:4/scale', derived: true }, { pos: ['1', '1'] });
    same(overlay.locks()['clip:3/scale'].pos.join(':'), '640:360',
         'and they are copies rather than two names for one thing');
}

console.log('\nnodes pinned to a clip that is gone');
{
    overlay.clear();
    overlay.insert('clip:3/after-scale', 'hflip');
    overlay.insert('clip:9/after-scale', 'vflip');
    overlay.edit({ anchor: 'composite/overlay:9', derived: true }, { pos: ['5', '5'] });

    overlay.retain([3]);
    same(overlay.insertCount(), 1, 'go when the clip does');
    same(overlay.inserts()[0].anchor, 'clip:3/after-scale', 'and the rest stay');
    same(overlay.lockCount(), 0, 'a lock on a gone clip goes too');

    // Anything not pinned to a clip belongs to the render rather than to any
    // one of its parts, and outlives all of them.
    overlay.insert('composite/after-overlay', 'vignette');
    overlay.retain([]);
    same(overlay.insertCount(), 1, 'and what belongs to the whole render survives an empty timeline');
}

console.log('\nremembered');
{
    overlay.clear();
    overlay.insert('clip:3/after-scale', 'eq');
    overlay.edit({ anchor: 'clip:3/scale', derived: true }, { pos: ['800', '600'] });

    // `remember()` runs on every change; restore() reads the same key back.
    overlay.clear();
    same(overlay.insertCount(), 0, 'cleared');
    overlay.restore();
    same(overlay.insertCount(), 0, 'and a cleared overlay stays cleared through a restore');

    overlay.insert('clip:3/after-scale', 'eq');
    overlay.edit({ anchor: 'clip:3/scale', derived: true }, { pos: ['800', '600'] });
    overlay.restore();
    same(overlay.insertCount(), 1, 'what was there comes back');
    same(overlay.locks()['clip:3/scale'].pos.join(':'), '800:600', 'lock and all');
    overlay.clear();
}

// ── the two graphs, with a filter in them ──────────────────────────────────

console.log('\nthe run graph carries the user’s filters too');
{
    const { renderGraph, filtergraph } = globalThis.__ffmpegBro;
    const spec = oneClip();
    spec.pixelFormat = 'yuv420p';
    const ov = { inserts: [{ id: 'u1', anchor: 'composite/after-overlay', filter: 'hflip',
                             pos: [], params: {} }], locks: {} };

    const shown = filtergraph(spec, null, { overlay: ov });
    const run = renderGraph(spec, null, { overlay: ov });
    ok(shown.ok && run.ok, 'both forms derive');

    const runChains = run.filterGraph.split(';');
    same(runChains.length, shown.chains.length, 'the same number of chains either way');
    const differing = shown.chains.filter((c, i) => c !== runChains[i]);
    same(differing.length, 1, 'differing by exactly one — the conversion the writer does here');
    const runVideo = runChains.find((c) => c.endsWith('[vout]'));
    ok(/hflip\[vout\]$/.test(runVideo),
       `and the filter is in the one that runs: ${runVideo}`);
    const shownVideo = shown.chains.find((c) => c.endsWith('[vout]'));
    ok(/hflip,scale=.*out_color_matrix/.test(shownVideo),
       `while the printed one carries on into the encoder’s colour: ${shownVideo}`);
}

// ── the graph, cut off at one node ─────────────────────────────────────────
//
// What a node produces is the thing a card cannot state and a picture can, and
// the picture comes from rendering the graph up to that node. Everything about
// that is a text transformation, so it is checked here rather than by looking
// at the pixels: if the chains are right the renderer's own tests already say
// the picture is.

console.log('\nthe graph, cut off at one node');
{
    const { previewGraph } = globalThis.__ffmpegBro.graph;
    const d = derive(oneClip());
    const at = (anchor, opts) => previewGraph(d.graph, d.graph.byAnchor(anchor), opts);

    const early = at('clip:7/trim', { fit: 160 });
    ok(early.ok, 'a node in the middle of a chain can be rendered on its own');
    same(early.filterGraph,
         "[0:v]trim=start=0:end=4[x0];[x0]scale=w='min(160\\,trunc(iw/2)*2)':h=-2[pv]",
         'everything downstream of it is gone, and a scale fits it into the card');
    same(early.filterInputs.length, 1, 'and it opens only the files it depends on');

    // Which is the point of cutting: previewing the first filter of a two-clip
    // edit must not decode the second clip.
    const two = derive({
        width: 1920, height: 1080, fps: 30, start: 0, end: 4, audio: true,
        clips: [oneClip().clips[0],
                Object.assign({}, oneClip({ id: 8 }).clips[0], { path: 'b.mp4' })],
    });
    same(previewGraph(two.graph, two.graph.byAnchor('clip:7/scale')).filterInputs.length, 1,
         'one clip’s chain reads one file, whatever else is on the timeline');
    same(previewGraph(two.graph, two.graph.byAnchor('composite/overlay:8')).filterInputs.length, 2,
         'and the composite reads both');

    // A pad that already has a name keeps it; `print()` only names chain ends,
    // and cutting a run in half makes a chain end out of a node that had none.
    const tail = at('clip:7/format');
    ok(/\[v0\]$/.test(tail.filterGraph.split(';')[0]),
       `a node that was already a chain end keeps its own pad: ${tail.filterGraph.split(';')[0]}`);
    ok(tail.filterGraph.indexOf('[v0]scale=') > 0, 'and the fit reads it by that name');

    // An input is not a filter and cannot be a chain, so there is nothing to
    // print in front of the scale that fits it.
    const source = at('clip:7/in:v');
    ok(source.ok, 'an input node can be previewed');
    ok(/^\[0:v\]scale=/.test(source.filterGraph),
       `which is the stream itself: ${source.filterGraph}`);

    same(previewGraph(d.graph, d.graph.byAnchor('out:v')).ok, false,
         'a sink is refused — it is the pad the muxer maps, not a picture');
    same(previewGraph(d.graph, null).ok, false, 'and so is nothing at all');

    // The card's width is what the picture is rendered at, so dragging one
    // wider is a sharper render rather than a stretched one.
    ok(at('clip:7/trim', { fit: 480 }).filterGraph.indexOf('min(480') > 0,
       'the fit is the size asked for');
}

// ── the stage, with nothing to draw ────────────────────────────────────────
//
// The half of the Graph stage this test can reach. Everything else about it
// needs a real edit and a stage that has been on screen to be measured on,
// which is tests/ui_player.js — but the refusal is exactly the case that has
// no media by definition, and a stage that answers an empty timeline with an
// empty screen is one you cannot tell from a broken one.

console.log('\nthe stage with nothing on the timeline');
{
    const { shell } = globalThis.__ffmpegBro;
    same(shell.stages().indexOf('graph'), 2,
         'Graph sits between Compose and Encode, where it is in ffmpeg');
    ok(shell.goTo('graph'), 'and it opens with nothing loaded — there is still something to say');
    pump(200);

    const note = document.getElementById('gr-note');
    ok(note && !note.classList.contains('hidden'),
       `the refusal is on screen: "${note ? note.textContent : '(no note)'}"`);
    // In the same words the derivation refused with. An edit that cannot be
    // described is one fact, not two — a stage that invents its own phrasing
    // for it is a second place for the reason to go stale.
    const reason = derive(globalThis.__ffmpegBro.exporter.buildSpec(), []).reason;
    ok(note.textContent.indexOf(reason) >= 0, `and it says why: "${reason}"`);
    same(document.querySelectorAll('#gr-nodes .gn').length, 0, 'and nothing is drawn');
}

console.log(`\nPASS ui_graph — ${checks} checks`);
