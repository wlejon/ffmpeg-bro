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

console.log(`\nPASS ui_graph — ${checks} checks`);
