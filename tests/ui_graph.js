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
// Usage: ffmpeg-bro-headless ui/ tests/ui_graph.js [-- <media-file>]
//
// Most of it needs no media: a graph is a plain object and every question below
// is about the shape of one. The last section is the wiring *gesture*, which
// needs sockets to exist somewhere on a screen — and nothing is anywhere until
// there is an edit to derive a graph from — so it is skipped without a file.

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
const { makeGraph, restore, derive, print, layout, portY,
        problems, padsOf, socketAt } = globalThis.__ffmpegBro.graph;
ok(typeof makeGraph === 'function', 'the graph model is on the test surface');

// ── how many pads a filter has ─────────────────────────────────────────────
//
// The question the whole of the free graph rests on, and the one thing on this
// screen that libavfilter does not simply answer: a dynamic filter's pad count
// is a function of an option value, and nothing in the metadata says which
// option.

console.log('\npads');
{
    same(JSON.stringify(padsOf('overlay')), '{"ins":["v","v"],"outs":["v"]}',
         'a fixed filter is what libavfilter declares');
    same(JSON.stringify(padsOf('color')), '{"ins":[],"outs":["v"]}',
         'a source reads nothing');
    same(padsOf('nosuchfilterhere'), null,
         'and a filter this build does not have gets no shape invented for it');

    // **The dynamic flag is not the count.** `scale` carries
    // AVFILTER_FLAG_DYNAMIC_INPUTS — it grows a pad for `scale2ref` — while
    // declaring one input and having nothing in its option table that counts
    // anything. Read as a count, its first positional argument made
    // `scale=1920:1080` a node with 1920 input sockets, clamped to 64 and
    // reported as sixty-three empty pads on every graph the application drew.
    same(padsOf('scale', {}, ['1920', '1080']).ins.length, 1,
         'a filter that is dynamic and says nothing about how many keeps the pads it declares');

    same(padsOf('amix').ins.length, 2, 'amix takes what its own option table defaults to');
    same(padsOf('amix', { inputs: '3' }).ins.length, 3, 'and what it is told');
    same(padsOf('amix', {}, ['4']).ins.length, 4,
         'including as a positional argument — amix=4 is amix=inputs=4');
    same(padsOf('amix').ins.join(''), 'aa', 'its pads carry the stream it produces');
    same(padsOf('split', {}, ['3']).outs.length, 3, 'split counts on the way out');
    same(padsOf('hstack', { inputs: '3' }).ins.join(''), 'vvv', 'and a picture filter is a picture');

    // concat is the one that does not fit a single count, because its count
    // multiplies: three segments of one picture and one sound is six pads in
    // and two out, and the pads are grouped per segment.
    same(padsOf('concat', { n: '3', v: '1', a: '1' }).ins.join(''), 'vavava',
         'concat groups its pads per segment');
    same(padsOf('concat', { n: '3', v: '1', a: '1' }).outs.join(''), 'va',
         'and produces one set of them');
}

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

console.log('\nports on the way out');
{
    // A node can have more than one output, and an edge says which it left by.
    // An input is the one that does: `[0:v]` and `[0:a]` are two pads of one
    // `-i`, and a graph that drew them as two nodes was saying a file's picture
    // and its sound had nothing to do with each other.
    const g = makeGraph();
    const file = g.add({ kind: 'input', index: 0, path: 'a.mp4',
                         outs: [{ stream: 'v' }, { stream: 'a' }] });
    const pic = g.add({ filter: 'hflip', label: 'v0' });
    const snd = g.add({ filter: 'volume', label: 'a0' });
    g.connect(file, pic, 0, 0);
    g.connect(file, snd, 0, 1);

    same(g.outPorts(file), 2, 'a node reports how many outputs it has');
    same(g.outPorts(pic), 1, 'and a filter has the one it never mentions');
    const chains = print(g).chains.slice().sort().join(' ');
    same(chains, '[0:a]volume[a0] [0:v]hflip[v0]',
         'each chain names the pad its wire left by');

    // Splicing has to respect it too. A filter dropped on the picture that took
    // the sound with it would put an `hflip` in front of `volume`.
    g.insertAfter(file, { id: 'u1', filter: 'crop' }, 0);
    same(print(g).chains.slice().sort().join(' '), '[0:a]volume[a0] [0:v]crop,hflip[v0]',
         'and an insertion moves only the wires leaving that one');

    // ...and so does healing. Removing the spliced node must put the picture
    // back on the picture pad, not on whichever pad came first.
    g.remove('u1');
    same(print(g).chains.slice().sort().join(' '), '[0:a]volume[a0] [0:v]hflip[v0]',
         'removing it wires the picture back to the pad it came from');
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
    // Two consumers of *one* pad is not valid ffmpeg without a `split`. The
    // model can now say what split needs — a node with two outputs and edges
    // that name which they leave by, which is what an input node uses — so
    // this is a graph somebody could write by hand rather than one that cannot
    // exist. The chain rule still has to break here rather than print two
    // chains that both claim to end at the same anonymous pad.
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

// ── what a graph will not run for ──────────────────────────────────────────
//
// The printer prints whatever it is given, because half of what asks it is a
// *pruned* view where outputs deliberately go nowhere — that is what previewing
// one node means. So refusal lives beside it, is asked only of a whole graph,
// and every shape below is one ffmpeg itself rejects.
//
// The rule is refusal, not approximation. A filtergraph is worth showing
// because it can be taken elsewhere and run, and one ffmpeg would reject is
// worse than no graph at all because it looks like one.

console.log('\nan empty input pad');
{
    const g = makeGraph();
    const a = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4', outs: [{ stream: 'v' }] });
    // Declared pads rather than counted wires, which is the whole difference:
    // an overlay with one wire on it has an *empty pad*, and a node drawn from
    // its wires cannot say so because there is nothing there to draw.
    const o = g.add({ filter: 'overlay', ins: [{ stream: 'v' }, { stream: 'v' }],
                      outs: [{ stream: 'v' }], label: 'out' });
    g.connect(a, o, 0);
    g.connect(o, g.add({ kind: 'sink', stream: 'v' }), 0);

    const found = problems(g);
    same(found.length, 1, 'one thing is wrong');
    ok(/overlay has nothing wired to its input 2 of 2/.test(found[0].reason),
       `and it names the node and the pad: ${found[0].reason}`);
    same(found[0].key, o.id, 'against the node it is about, so a card can be marked');

    const b = g.add({ kind: 'input', stream: 'v', index: 1, path: 'b.mp4', outs: [{ stream: 'v' }] });
    g.connect(b, o, 1);
    same(problems(g).length, 0, 'and filling it is the whole of the fix');
}

console.log('\na pad read twice');
{
    // Two consumers of one pad is what `split` is for. ffmpeg says "Label found
    // twice" about a graph it has already half-parsed, which is a sentence about
    // its own parser rather than about the picture.
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4', outs: [{ stream: 'v' }] });
    const fork = g.run(src, [{ filter: 'hflip', ins: [{ stream: 'v' }], outs: [{ stream: 'v' }] }], 'fork');
    const one = g.run(fork, [{ filter: 'negate', ins: [{ stream: 'v' }], outs: [{ stream: 'v' }] }], 'one');
    g.run(fork, [{ filter: 'vflip', ins: [{ stream: 'v' }], outs: [{ stream: 'v' }] }], 'two');
    g.connect(one, g.add({ kind: 'sink', stream: 'v' }), 0);

    const said = problems(g).map((p) => p.reason).join(' | ');
    ok(/hflip’s output is read by 2 filters/.test(said), `the fork is named: ${said}`);
    ok(/put a split in between/.test(said), 'and so is what to do about it');
    // The printer still prints it — it prints what it is given, and what it
    // gives back for this is three chains that name `[fork]` twice.
    same(print(g).chains.length, 3, 'while the printer still prints the shape it is given');
}

console.log('\na pad nothing reads');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4', outs: [{ stream: 'v' }] });
    const s = g.run(src, [{ filter: 'split', ins: [{ stream: 'v' }],
                            outs: [{ stream: 'v' }, { stream: 'v' }] }], 'a');
    g.connect(s, g.add({ kind: 'sink', stream: 'v' }), 0, 0);

    const said = problems(g).map((p) => p.reason).join(' | ');
    ok(/nothing reads split’s output 2 of 2/.test(said),
       `a split whose second output goes nowhere is refused: ${said}`);
}

console.log('\na picture wire in an audio pad');
{
    const g = makeGraph();
    const file = g.add({ kind: 'input', index: 0, path: 'a.mp4',
                         outs: [{ stream: 'v' }, { stream: 'a' }] });
    const mix = g.add({ filter: 'amix', ins: [{ stream: 'a' }, { stream: 'a' }],
                        outs: [{ stream: 'a' }], label: 'aout' });
    g.connect(file, mix, 0, 1);       // the sound, correctly
    g.connect(file, mix, 1, 0);       // the picture, into an audio pad
    g.connect(mix, g.add({ kind: 'sink', stream: 'a' }), 0);

    const said = problems(g).map((p) => p.reason).join(' | ');
    ok(/a picture wire arrives at amix’s input 2 of 2, which takes sound/.test(said),
       `named as what it is rather than as a pad index: ${said}`);
}

console.log('\na circle');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4', outs: [{ stream: 'v' }] });
    const a = g.add({ filter: 'hflip', ins: [{ stream: 'v' }], outs: [{ stream: 'v' }] });
    const b = g.add({ filter: 'vflip', ins: [{ stream: 'v' }], outs: [{ stream: 'v' }] });
    g.connect(src, a, 0);
    g.connect(a, b, 0);
    g.connect(b, a, 0);               // back to where it came from

    const said = problems(g).map((p) => p.reason).join(' | ');
    ok(/feed each other in a circle/.test(said), `a cycle is named rather than hung on: ${said}`);
    ok(/hflip/.test(said) && /vflip/.test(said), 'and both nodes are in the sentence');
    // The layout and the stream walk both survive one by giving up after a
    // bounded number of passes, which is what stops the stage hanging while
    // this is being said.
    ok(layout(g, () => ({ w: 100, h: 40 }), () => null).nodes.length === 3,
       'and the layout still draws something');
}

console.log('\na filter this build does not have');
{
    const g = makeGraph();
    const src = g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4', outs: [{ stream: 'v' }] });
    const bad = g.run(src, [{ filter: 'unsharpenator' }], 'out');
    g.connect(bad, g.add({ kind: 'sink', stream: 'v' }), 0);
    const said = problems(g).map((p) => p.reason).join(' | ');
    ok(/has no filter called “unsharpenator”/.test(said),
       `an unknown filter is an error, not a shrug: ${said}`);
}

console.log('\na sink with nothing on it');
{
    const g = makeGraph();
    g.add({ kind: 'input', stream: 'v', index: 0, path: 'a.mp4', outs: [{ stream: 'v' }] });
    g.add({ kind: 'sink', stream: 'v' });
    const said = problems(g).map((p) => p.reason).join(' | ');
    ok(/nothing is wired to video out/.test(said),
       `a render with nothing mapped is refused: ${said}`);
    ok(/no picture to write/.test(said), 'and said in terms of what would be written');
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

    // Outputs and the pad each wire leaves by, which is what a two-stream input
    // node is made of. A round trip that dropped either would come back as a
    // graph whose sound reads the picture.
    const f = makeGraph();
    const file = f.add({ kind: 'input', index: 0, path: 'a.mp4',
                         outs: [{ stream: 'v' }, { stream: 'a' }] });
    f.run(file, [{ filter: 'hflip' }], 'v0');
    f.run({ node: file, out: 1 }, [{ filter: 'volume' }], 'a0');
    same(print(restore(JSON.parse(JSON.stringify(f.toJSON())))).chains.slice().sort().join(' '),
         print(f).chains.slice().sort().join(' '),
         'a node’s outputs and the pad each wire leaves by survive the round trip');

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
    // One node per *file*, because one file is one `-i`. Its picture and its
    // sound are two outputs of it rather than two nodes that happen to name the
    // same path — which is what `[0:v]` and `[0:a]` already meant, and what the
    // graph drew as two unrelated things until an edge could say which pad it
    // left by.
    same(kinds.input, 2, 'one input node per clip, however many streams it is read for');
    const ins = g.nodes.filter((n) => n.kind === 'input');
    same(ins.map((n) => n.outs.map((o) => o.stream).join('')).join(' '), 'va va',
         'each of them with an output per stream — the picture and the sound');
    same(g.outPorts(ins[0]), 2, 'which the model reports as two output ports');
    same(kinds.sink, 2, 'and one sink per stream the muxer maps');

    // The sound leaves by the second pad, and the printer says so. This is the
    // whole of what `fromPort` buys: without it both wires out of one node
    // print as `[0:v]`, and the audio chain reads the picture.
    const chains = print(g).chains;
    ok(chains.some((c) => c.indexOf('[0:a]atrim=') === 0),
       `the first clip’s sound is read from its own pad: ${chains.join(';')}`);
    ok(chains.some((c) => c.indexOf('[1:a]atrim=') === 0),
       'and the second clip’s from its own');
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

    // A clip's picture and its sound now leave one input node by two pads, so
    // an insertion on either has to name which. Put on the sound, it must not
    // take the picture with it — the failure that would be is an `atempo` in
    // front of the trim of the *video* chain, which parses and renders nothing.
    const onSound = derive(oneClip(), null, {
        overlay: { inserts: [{ id: 'u1', anchor: 'clip:7/audio', filter: 'aecho',
                               pos: [], params: {} }], locks: {} },
    });
    ok(/^\[0:a\]aecho,atrim=/.test(chainFor(onSound, 'a0')),
       `a filter on the clip’s sound lands on its audio pad: ${chainFor(onSound, 'a0')}`);
    ok(/^\[0:v\]trim=/.test(chainFor(onSound, 'v0')),
       `and the picture leaves the same node untouched: ${chainFor(onSound, 'v0')}`);
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

// ── structure a person made ────────────────────────────────────────────────
//
// The step past splicing. A filter with two inputs cannot be dropped on a wire,
// so it is placed and then wired — which means the overlay has to hold nodes
// that are on no wire, wires nobody derived, and derived wires somebody took
// off. All three have to survive the skeleton being thrown away and rebuilt,
// and the only string that survives that is a key: an anchor for a derived node,
// an id for one of yours.

/// The video sink's producer, as the chain that ends up feeding it.
const videoChain = (d) => print(d.graph).chains.find((c) => c.endsWith(print(d.graph).video));

console.log('\na node on no wire, wired by hand');
{
    overlay.clear();
    // A picture laid over the finished composite: a `color` source and an
    // `overlay` that reads it, spliced in front of the sink. Neither of them
    // can be reached by splicing — `color` has no input to be spliced onto and
    // `overlay` has two — which is exactly the gap this closes.
    const bg = overlay.addNode('color', { params: { c: 'red', s: '64x64', d: '4' } });
    const over = overlay.addNode('overlay', { pos: ['16', '16'] });
    overlay.wire(bg.id, 0, over.id, 1);
    overlay.wire('composite/overlay:7', 0, over.id, 0);
    overlay.wire(over.id, 0, 'out:v', 0);

    const spec = oneClip();
    spec.pixelFormat = 'yuv420p';
    const d = derive(spec, null, { overlay: overlay.current() });
    ok(d.ok, 'the graph still derives with hand-made structure in it');
    same(d.problems.length, 0, `and nothing is wrong with it: ${
        d.problems.map((p) => p.reason).join(' | ')}`);

    const chains = print(d.graph).chains;
    ok(chains.some((c) => /^color=/.test(c)), `the placed source is a chain of its own: ${
        chains.filter((c) => /color=c=red/.test(c)).join('')}`);
    ok(/overlay=16:16/.test(videoChain(d)),
       `and the picture goes through the overlay you wired: ${videoChain(d)}`);
    // The derived wire into the sink was replaced rather than joined: an input
    // pad holds one wire, which is what makes wiring something *between* two
    // derived nodes a single gesture.
    same(d.graph.inEdges(d.graph.byAnchor('out:v')).length, 1,
         'the sink still reads exactly one thing');
    // The colour conversion is attached *after* everything a person did, which
    // is what makes it impossible to wire something behind it — those two nodes
    // are in the printed graph and not in the one this binary runs, so a wire
    // ending on one of them would be a wire that is in the command you copied
    // and absent from the render you got.
    same(d.graph.producers(d.graph.byAnchor('output/color'))[0].id, over.id,
         'and what feeds the encoder’s colour conversion is the node you put there');

    // The whole point. A timeline edit throws the skeleton away and derives a
    // new one with entirely different ids; anchors and user ids are what carry
    // across.
    const movedSpec = oneClip({ w: 640, h: 360 });
    movedSpec.pixelFormat = 'yuv420p';
    const moved = derive(movedSpec, null, { overlay: overlay.current() });
    ok(/overlay=16:16/.test(videoChain(moved)),
       'a timeline edit rebuilds the skeleton and the hand wiring is still on it');
    same(moved.problems.length, 0, 'and still runs');

    // ...and the *render* graph, which is the one that decides whether a render
    // goes through libavfilter, carries it too.
    const run = globalThis.__ffmpegBro.renderGraph(spec, null, { overlay: overlay.current() });
    ok(run.ok && /overlay=16:16/.test(run.filterGraph),
       'and so does the graph the renderer is handed');
}

console.log('\na wire taken off is remembered as a cut');
{
    overlay.clear();
    ok(overlay.isEmpty(), 'nothing to begin with');
    overlay.unwire('out:v', 0);
    ok(!overlay.isEmpty(),
       'a cut is structure — the render goes through libavfilter for one, ' +
       'because the graph is no longer the one the compositor would produce');

    const d = derive(oneClip(), null, { overlay: overlay.current() });
    ok(d.ok, 'the graph still derives');
    ok(d.problems.some((p) => /nothing is wired to video out/.test(p.reason)),
       `and says what is now missing: ${d.problems.map((p) => p.reason).join(' | ')}`);
    // Refused rather than rendered. A render that quietly put the wire back
    // would be rendering something other than what is on the screen.
    same(globalThis.__ffmpegBro.renderGraph(oneClip(), null, { overlay: overlay.current() }).ok,
         false, 'and a render is refused rather than made from a graph that will not run');

    // The skeleton grows the wire back on every rebuild, so the absence has to
    // be written down — which is why a cut is a thing rather than the lack of
    // one.
    same(derive(oneClip(), null, { overlay: overlay.current() })
            .graph.inEdges(derive(oneClip()).graph.byAnchor('out:v')).length, 0,
         'a rebuild does not put it back');

    overlay.reconnect('out:v', 0);
    ok(overlay.isEmpty(), 'and giving the pad back is giving it back');
    same(derive(oneClip(), null, { overlay: overlay.current() }).problems.length, 0,
         'the derivation fills it in again');
}

console.log('\na pad count that changes under a wire');
{
    overlay.clear();
    const mix = overlay.addNode('amix', { params: { inputs: '3', normalize: '0' } });
    overlay.wire('audio/after-mix', 0, mix.id, 2);
    overlay.wire(mix.id, 0, 'out:a', 0);
    // `audio/after-mix` is a point, not a node — the wire has to name the node
    // the point sits on, which for one audible clip is that clip's own tail.
    const tail = derive(oneClip()).graph.byAnchor('clip:7/asetpts');
    overlay.reconnect(mix.id, 2);
    overlay.wire(keyOfNode(tail), 0, mix.id, 2);

    let d = derive(oneClip(), null, { overlay: overlay.current() });
    ok(d.graph.node(mix.id), 'a three-input mixer is in the graph');
    same(d.graph.inPorts(d.graph.node(mix.id)), 3, 'with the three pads it was told to have');
    ok(d.problems.some((p) => /amix has nothing wired to its input 1 of 3/.test(p.reason)),
       'and the two you have not filled are named');

    // Now take a pad away under the wire. The wire cannot be applied, and the
    // one thing it must not do is vanish: putting the count back has to bring
    // it back, or a mistyped number is lost work.
    overlay.edit({ id: mix.id, derived: false }, { params: { inputs: '2' } });
    d = derive(oneClip(), null, { overlay: overlay.current() });
    const stranded = d.problems.find((p) => /nowhere to land/.test(p.reason));
    ok(!!stranded, `the wire is reported rather than dropped: ${stranded && stranded.reason}`);
    ok(/amix has 2 inputs/.test(stranded.reason) && /input 3/.test(stranded.reason),
       'naming the node, what it has and where the wire wanted to go');
    same(overlay.wires().filter((w) => w.to === mix.id && w.port === 2).length, 1,
         'and the wire is still in the overlay');

    overlay.edit({ id: mix.id, derived: false }, { params: { inputs: '3' } });
    d = derive(oneClip(), null, { overlay: overlay.current() });
    ok(!d.problems.some((p) => /nowhere to land/.test(p.reason)),
       'putting the count back puts the wire back');
    same(d.graph.inEdges(d.graph.node(mix.id)).filter((e) => e.port === 2).length, 1,
         'on the pad it named');
}

/// A node's key, which is what a wire's ends are written as.
function keyOfNode(n) { return n.derived ? n.anchor : n.id; }

console.log('\na node taken out takes its wires');
{
    overlay.clear();
    const a = overlay.addNode('hflip');
    overlay.wire('composite/overlay:7', 0, a.id, 0);
    overlay.wire(a.id, 0, 'out:v', 0);
    same(overlay.wireCount(), 2, 'two wires');

    overlay.removeInsert(a.id);
    same(overlay.nodeCount(), 0, 'the node goes');
    same(overlay.wireCount(), 0, 'and so do the wires that ended on it — an endpoint ' +
                                 'naming a node that will never exist again is not kept');
    same(derive(oneClip(), null, { overlay: overlay.current() }).problems.length, 0,
         'and the derivation is whole again');
}

console.log('\nan endpoint whose clip is out of range');
{
    overlay.clear();
    const flip = overlay.addNode('hflip');
    overlay.wire('clip:7/format', 0, flip.id, 0);
    overlay.wire(flip.id, 0, 'composite/overlay:7', 1);

    const away = oneClip();
    away.start = 10;
    away.end = 14;
    same(derive(away, null, { overlay: overlay.current() }).ok, false,
         'nothing falls inside the range, so there is no graph');
    same(overlay.wireCount(), 2, 'and the wires are still there for when the clip comes back');

    const back = derive(oneClip(), null, { overlay: overlay.current() });
    same(back.problems.length, 0, `which it does, unchanged: ${
        back.problems.map((p) => p.reason).join(' | ')}`);
    ok(/format=rgba,hflip\[/.test(print(back.graph).chains.join(';')),
       'and the hand-made wiring is back on the rebuilt skeleton');

    // A clip that is deleted rather than trimmed out is different: the anchor
    // will never mean anything again, so the wire goes with it.
    overlay.retain([]);
    same(overlay.wireCount(), 0, 'a wire on a clip that is gone goes with it');
    same(overlay.nodeCount(), 1, 'while a node of yours, which belongs to no clip, stays');
    overlay.clear();
}

console.log('\na split does not copy the wiring');
{
    overlay.clear();
    overlay.insert('clip:3/after-scale', 'hflip');
    const mine = overlay.addNode('overlay');
    overlay.wire('clip:3/format', 0, mine.id, 0);
    overlay.cloneClip(3, 4);

    same(overlay.insertCount(), 2, 'a cut copies the filters, because a cut should not ' +
                                   'change how either half looks');
    same(overlay.wires().length, 1,
         'and does not copy the wires — an input pad holds one wire, so a copy of one ' +
         'would be a second producer arriving at a pad that already has one');
    overlay.clear();
}

console.log('\nstructure survives a reload');
{
    overlay.clear();
    const node = overlay.addNode('overlay', { pos: ['4', '4'] });
    overlay.wire('composite/overlay:7', 0, node.id, 0);
    overlay.unwire('composite/overlay:7', 1);
    overlay.restore();

    same(overlay.nodeCount(), 1, 'a node you placed comes back');
    same(overlay.nodes()[0].pos.join(':'), '4:4', 'configured as it was');
    same(overlay.wires().length, 1, 'so does the wire');
    same(overlay.wires()[0].from, 'composite/overlay:7', 'with both of its ends');
    same(overlay.wires()[0].to, node.id, 'written as keys rather than as objects');
    ok(overlay.isCut('composite/overlay:7', 1), 'and so does the cut');

    // Ids come out of one counter for everything in this file, so that no two
    // things in it can be told apart by their id and then turn out not to be.
    const after = overlay.addNode('hflip');
    ok(after.id !== node.id, `a restore takes its ids out of circulation (${after.id})`);
    overlay.clear();
}

console.log('\na blob written before any of this still loads');
{
    // The shape grew rather than changing, which is what makes an overlay
    // somebody spent an afternoon on survive an upgrade. Three keys it has
    // never heard of come back empty and everything it does know behaves the
    // way it always did.
    overlay.clear();
    localStorage.setItem('ffmpeg-bro.graph', JSON.stringify({
        inserts: [{ id: 'u77', anchor: 'clip:3/after-scale', filter: 'eq',
                    pos: [], params: { contrast: '1.2' } }],
        locks: { 'clip:3/scale': { params: {}, pos: ['800', '600'] } },
        sizes: {}, pins: {},
    }));
    overlay.restore();
    same(overlay.insertCount(), 1, 'the old shape loads');
    same(overlay.inserts()[0].params.contrast, '1.2', 'with what was in it');
    same(overlay.lockCount(), 1, 'locks and all');
    same(overlay.nodeCount(), 0, 'and the things it had never heard of are empty');
    same(overlay.wires().length, 0, 'rather than undefined');
    overlay.clear();
}

// ── where the cards are ────────────────────────────────────────────────────
//
// A position is not part of the graph and must never be mistaken for one. It is
// kept the way a card's width is — against the anchor, so it survives the
// skeleton being thrown away — and it is deliberately outside `isEmpty()`,
// because that is what decides which of the renderer's two paths a render takes
// and a card nudged sideways must not change what comes out of the encoder.

console.log('\na node dragged somewhere stays there');
{
    overlay.clear();
    overlay.unpinAll();
    same(overlay.pinOf('clip:3/scale'), null, 'nothing is pinned to begin with');

    overlay.setPin('clip:3/scale', 420, 96);
    same(overlay.pinOf('clip:3/scale').x, 420, 'a node remembers where it was put');
    same(overlay.pinCount(), 1, 'and the stage can count them');

    // The whole reason it is keyed by anchor: this is what a timeline edit does.
    overlay.restore();
    same(overlay.pinOf('clip:3/scale').y, 96, 'and it comes back after a reload');

    ok(overlay.isEmpty(),
       'a placed node is not a graph edit — isEmpty() ignores it, so the render ' +
       'still goes through the compositor');

    overlay.unpinAll();
    same(overlay.pinCount(), 0, 'Re-layout gives the whole graph back');

    // A filter applies to both halves of a cut; a position cannot, because two
    // cards cannot be in one place.
    overlay.setPin('clip:3/scale', 10, 10);
    overlay.insert('clip:3/after-scale', 'hflip');
    overlay.cloneClip(3, 4);
    same(overlay.insertCount(), 2, 'a split copies the filters');
    same(overlay.pinOf('clip:4/scale'), null, 'and does not copy the position onto them');

    // And a pin goes when its clip does, or the blob grows forever.
    overlay.retain([]);
    same(overlay.pinCount(), 0, 'a pin on a clip that is gone goes with it');
    overlay.clear();
}

console.log('\nthe layout, with something pinned');
{
    const d = derive(oneClip());
    const size = () => ({ w: 176, h: 80 });
    const free = layout(d.graph, size, () => null);
    const scale = d.graph.byAnchor('clip:7/scale');

    const pinned = layout(d.graph, size, (n) => (n === scale ? { x: -300, y: 500 } : null));
    const box = pinned.nodes.find((b) => b.node === scale);
    same(box.x, -300, 'a pinned node is where it was put');
    ok(box.pinned, 'and says so, so the card can show it');

    // A pin is visual. The nodes you did not touch do not move, which is the
    // difference between placing one node and rearranging the eight you were
    // happy with.
    const other = d.graph.byAnchor('clip:7/trim');
    same(pinned.nodes.find((b) => b.node === other).x,
         free.nodes.find((b) => b.node === other).x,
         'and nothing else moves for it');

    // Fit has to frame what is drawn, so a card dragged left of the first column
    // is part of the extent rather than off the edge of it.
    same(pinned.left, -300, 'the extent reaches out to it');
    ok(pinned.height >= 580, `and down to it (${Math.round(pinned.height)})`);

    // The one formula the wire and the socket both use. A dot anywhere other
    // than where the curve lands says this wire goes to that port when it does
    // not — and `overlay`'s two inputs are the canvas and the clip, which are
    // not interchangeable.
    same(portY(100, 0, 2), 100 / 3, 'the first of two ports is a third of the way down');
    same(portY(100, 1, 2), 200 / 3, 'and the second two thirds');
    same(portY(100, 0, 1), 50, 'a single port is halfway');

    const into = free.wires.filter((w) => w.edge.to === d.graph.byAnchor('composite/overlay:7').id);
    same(into.length, 2, 'the compositor reads two wires');
    ok(into[0].y2 !== into[1].y2, 'and they arrive at different heights');
    for (const w of into) {
        const off = w.y2 - free.nodes.find((b) => b.node.id === w.edge.to).y;
        // A tolerance rather than equality: the endpoint was added to the node's
        // top and is being taken off again, and a third of eighty does not
        // survive that exactly.
        ok(Math.abs(off - portY(80, w.edge.port, 2)) < 1e-6,
           `port ${w.edge.port} lands where portY says it does (${off.toFixed(2)})`);
    }

    // The same on the way out, which is new: a clip's picture and its sound
    // leave one input node, and two wires drawn from one point would say they
    // were the same stream.
    const file = d.graph.byAnchor('clip:7/in');
    const outOf = free.wires.filter((w) => w.edge.from === file.id);
    same(outOf.length, 2, 'the file is read twice');
    ok(outOf[0].y1 !== outOf[1].y1, 'and the two wires leave it at different heights');
    same(outOf.map((w) => w.stream).sort().join(''), 'av',
         'each carrying the stream of the pad it left by');
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
    const source = at('clip:7/in');
    ok(source.ok, 'an input node can be previewed');
    ok(/^\[0:v\]scale=/.test(source.filterGraph),
       `which is the stream itself: ${source.filterGraph}`);

    // The picture sink is the one node on the screen that means *the render*,
    // and it has no pad of its own — so it shows the pad it maps, which is
    // exactly what its producer shows.
    const out = previewGraph(d.graph, d.graph.byAnchor('out:v'));
    ok(out.ok, 'the video sink can be previewed');
    same(out.filterGraph, previewGraph(d.graph, d.graph.producers(d.graph.byAnchor('out:v'))[0])
         .filterGraph, 'and it is the same render as the node that feeds it');

    same(previewGraph(d.graph, null).ok, false, 'nothing at all is refused');

    // The card's width is what the picture is rendered at, so dragging one
    // wider is a sharper render rather than a stretched one.
    ok(at('clip:7/trim', { fit: 480 }).filterGraph.indexOf('min(480') > 0,
       'the fit is the size asked for');

    // ── a sound pad ────────────────────────────────────────────────────────
    //
    // `volume=0.6` is a claim about a sound in exactly the way `crop` is a
    // claim about a picture, so it gets the same treatment: split the pad,
    // draw one half with `showwaves` and keep the other, and what comes out is
    // an ordinary video with an ordinary soundtrack — which is what lets a card
    // play it through the same element every other node uses.
    const wave = at('clip:7/asetpts', { fit: 320, fps: 30 });
    ok(wave.ok, 'a sound pad can be previewed too');
    same(wave.audio, true, 'and says it carries a soundtrack, so a card can unmute it');
    const wchains = wave.filterGraph.split(';');
    same(wchains[0], '[0:a]atrim=start=0:end=4,asetpts=PTS-STARTPTS[a0]',
         'the chain up to the node is the same chain the render runs');
    same(wchains[1], '[a0]asplit=2[pa][pw]', 'split into what is heard and what is drawn');
    ok(/^\[pw\]showwaves=s=320x120:.*rate=30.*\[pv\]$/.test(wchains[2]),
       `and the drawing is libavfilter's own, at the render's rate: ${wchains[2]}`);
    same(wchains.length, 3, 'and nothing else');
    ok(wave.filterGraph.indexOf('scale=w=') < 0,
       'no picture scaler — there was never a picture to fit');

    // `showwaves` emits one blank frame before it emits any waveform, and that
    // is the frame a paused or looping card sits on — so every waveform on the
    // screen was a black rectangle until this was cut off the front. `tpad`
    // puts the frame back on the end, where dropping one would otherwise land
    // as a black flash at the end of the loop instead of the start.
    ok(/,trim=start_frame=1,setpts=PTS-STARTPTS,tpad=stop=-1:stop_mode=clone\[pv\]$/
        .test(wchains[2]),
       'with showwaves’ blank first frame cut off and the last one held instead');

    // The rate is not decoration. The writer stamps whatever arrives at the
    // output rate, so a waveform drawn at 25 inside a 30 fps render is a
    // picture running slow against its own sound — which reads as the filter
    // being wrong rather than the preview being wrong.
    ok(at('clip:7/asetpts', { fit: 320, fps: 25 }).filterGraph.indexOf('rate=25') > 0,
       'the waveform is drawn at whatever rate the render walks at');

    // Both sinks are worth a preview, and each shows what its producer hands
    // it. The sound one used to be refused outright.
    const aout = previewGraph(d.graph, d.graph.byAnchor('out:a'), { fit: 320, fps: 30 });
    ok(aout.ok && aout.audio, 'the audio sink can be previewed — it is the render too');
    same(aout.filterGraph, wave.filterGraph,
         'and it is the same render as the pad that feeds it');

    // Only the file's sound is opened. A waveform that decoded the picture as
    // well would be the most expensive thing on the screen and would look
    // identical.
    same(JSON.stringify(wave.filterInputs),
         JSON.stringify([{ label: '0:a', path: 'a.mp4', input: -1, stream: 'a', from: 0 }]),
         'reading one pad — the sound, not the picture beside it');
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
    const chain = shell.stages();
    same(chain.indexOf('graph'), chain.indexOf('compose') + 1,
         'Graph sits between Compose and Encode, where it is in ffmpeg');
    same(chain.indexOf('graph'), chain.indexOf('encode') - 1,
         'and nothing has been slipped in between them');
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
