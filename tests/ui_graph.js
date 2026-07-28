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
    same(JSON.stringify(padsOf('testsrc')), '{"ins":[],"outs":["v"]}',
         'and so does every other generator libavfilter has');
    same(JSON.stringify(padsOf('sine')), '{"ins":[],"outs":["a"]}',
         'including the ones that make sound');

    // `movie` is the second filter whose pads are a function of an option and
    // not of a count — the option is a *string* in ffmpeg's stream-specifier
    // syntax, so the general rule finds nothing to count and leaves the node
    // with no output pads at all, which is a node that cannot be wired.
    same(JSON.stringify(padsOf('movie')), '{"ins":[],"outs":["v"]}',
         'movie is one picture unless it is told otherwise');
    same(JSON.stringify(padsOf('amovie')), '{"ins":[],"outs":["a"]}',
         'and amovie is one sound');
    same(padsOf('movie', { streams: 'dv+da' }).outs.join(''), 'va',
         'a stream list is as many pads as it names');
    same(padsOf('movie', { s: 'a:0+v:0' }).outs.join(''), 'av',
         'in the order it names them, by the alias as well as the name');
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

console.log('\na node that produces something out of nothing');
{
    overlay.clear();
    // Nothing on the timeline at all. That used to be a refusal and is now a
    // render: `ffmpeg -f lavfi -i testsrc -t 5 out.mp4` is a thing people do
    // every day, and a timeline is one view of a media document rather than the
    // only thing a render can be made of.
    const bare = { width: 640, height: 360, fps: 25, start: 0, end: 2,
                   audio: true, clips: [] };
    same(derive(bare, null, { overlay: overlay.current() }).ok, false,
         'an empty timeline with an empty graph is still nothing to render');

    // What counts is a node that *produces*. An `hflip` nobody has wired cannot
    // be the whole of a render, and deriving a graph around it would report
    // five problems where "there is nothing to render" is the true sentence.
    const flip = overlay.addNode('hflip');
    same(derive(bare, null, { overlay: overlay.current() }).ok, false,
         'and an hflip nobody wired is not a source however alone it is');
    overlay.removeInsert(flip.id);

    const src = overlay.addNode('testsrc', { params: { size: '640x360', rate: '25' } });
    const d = derive(bare, null, { overlay: overlay.current() });
    ok(d.ok, `a graph rooted in a generator derives with no clips: ${d.reason || ''}`);
    ok(!d.graph.byAnchor('base'),
       'and there is no derived canvas in the way — a black rectangle nothing is laid ' +
       'over is a source nothing reads the moment you wire your own to the sink');
    ok(d.problems.some((p) => /nothing is wired to video out/.test(p.reason)),
       'so the sink is empty until you fill it');

    overlay.wire(src.id, 0, 'out:v', 0);
    const wired = derive(bare, null, { overlay: overlay.current() });
    same(wired.problems.length, 0, `and then it runs: ${
        wired.problems.map((p) => p.reason).join(' | ')}`);
    const chain = print(wired.graph).chains.join(';');
    ok(/^testsrc=/.test(chain), `the generator is the whole filtergraph: ${chain}`);
    ok(/size=640x360/.test(chain), 'configured with the size the render is');
    ok(!!print(wired.graph).video, 'and the muxer has a pad to map');

    const run = globalThis.__ffmpegBro.renderGraph(bare, null, { overlay: overlay.current() });
    ok(run.ok && /testsrc/.test(run.filterGraph),
       `the renderer is handed it too: ${run.reason || ''}`);
    same(run.filterInputs.length, 0, 'and it opens no files at all');
    overlay.clear();
}

console.log('\na file the graph reads that no clip is cut from');
{
    overlay.clear();
    // The watermark, which is what this whole shape is for. **It is an `-i`,
    // not a `movie=`** — everything that decides how a file opens belongs to
    // the input, and the row on the Sources stage is already there.
    const spec = oneClip();
    spec.clips[0].input = 0;
    spec.inputs = [{ path: 'a.mp4' }, { path: 'logo.png' }];
    spec.inputInfo = [
        { id: 'in1', name: 'a.mp4', path: 'a.mp4', streams: ['v', 'a'] },
        { id: 'in2', name: 'logo.png', path: 'logo.png', streams: ['v'] },
    ];

    const logo = overlay.addSource('in2');
    const mark = overlay.addNode('overlay', { pos: ['16', '16'] });
    overlay.wire('composite/overlay:7', 0, mark.id, 0);
    overlay.wire(logo.id, 0, mark.id, 1);
    overlay.wire(mark.id, 0, 'out:v', 0);

    const d = derive(spec, null, { overlay: overlay.current() });
    ok(d.ok, `a watermark derives: ${d.reason || ''}`);
    same(d.problems.length, 0, `and nothing is wrong with it: ${
        d.problems.map((p) => p.reason).join(' | ')}`);

    const node = d.graph.node(logo.id);
    ok(!!node && node.kind === 'input', 'the source is an input node — a file, not a filter');
    same(node.index, 1, 'numbered after the clips’, because the graph numbers the pads it reads');
    same(node.input, 1, 'and carrying which of the document’s inputs it is, which is what ' +
                        'the demuxer, the option bag and the window travel on');
    same(node.outs.length, 1, 'with a pad per stream the probe found and no more');

    const p = print(d.graph);
    same(p.inputs[1], 'logo.png', 'the printed command opens it');
    same(p.inputRefs[1], 1, 'as the input it is, rather than as a bare path');
    ok(/\[1:v\]/.test(p.chains.join(';')), `and a chain reads its pad: ${p.chains.join(';')}`);

    const run = globalThis.__ffmpegBro.renderGraph(spec, null, { overlay: overlay.current() });
    ok(run.ok && run.filterInputs.some((i) => i.label === '1:v' && i.input === 1),
       'and the renderer is told which -i feeds [1:v]');
    ok(!run.filterInputs.some((i) => i.label === '1:a'),
       'one entry per pad that is *read* — a logo opened for its picture is not ' +
       'decoded for sound it has not got');

    // The Sources stage's whole claim is that it is every file this render
    // opens, so it has to be able to ask.
    same(overlay.sourceInputs().join(), 'in2',
         'and the Sources stage can ask which inputs the graph reads on its own account');

    // An input that is taken off the Sources stage takes the node with it —
    // the opposite of the rule for a clip out of range, because a removed input
    // is gone and its id is never handed out again.
    overlay.retain([7], ['in1']);
    same(overlay.nodeCount(), 1, 'removing the input removes the node that named it');
    same(overlay.wires().length, 2, 'and the wires that ended on it');
    overlay.clear();
}

console.log('\na source node is not written to disk');
{
    // There is still no project file, so the inputs themselves do not survive a
    // restart and their ids start at one again every run. A restored `in3`
    // would name whichever file happened to be third next time, which is worse
    // than losing the node.
    overlay.clear();
    const keep = overlay.addNode('hflip');
    overlay.addSource('in2');
    overlay.wire('clip:7/format', 0, keep.id, 0);
    overlay.restore();
    same(overlay.nodeCount(), 1, 'the filter comes back');
    same(overlay.nodes()[0].filter, 'hflip', 'as itself');
    same(overlay.sourceInputs().length, 0, 'and the node naming an input does not');
    overlay.clear();
}

console.log('\nwhat a node that is gone takes with it');
{
    // Three places lose a node — removing one, an input taken off the Sources
    // stage, and the read above that will not put one back — and each of them
    // has to take the same things: what was spliced onto its own pads, how wide
    // the card was dragged and where it was dropped. Left behind, those are not
    // merely waste: `pins` and `sizes` are keyed by the node's id, the counter
    // hands ids out again after a restart, and the next filter spliced in
    // arrives at a width and a position nobody gave it.
    overlay.clear();
    overlay.unpinAll();

    const n = overlay.addNode('hflip');
    overlay.setPin(n.id, 40, 50);
    overlay.setSize(n.id, 300);
    overlay.removeInsert(n.id);
    same(overlay.pinOf(n.id), null, 'a node you remove takes its position with it');
    same(overlay.sizeOf(n.id), 0, 'and how wide you dragged it');

    overlay.clear();
    overlay.unpinAll();
    const src = overlay.addSource('in2');
    overlay.setPin(src.id, 37, 778);
    overlay.setSize(src.id, 260);
    overlay.insert(`${src.id}/after-decode`, 'eq');
    overlay.restore();
    same(overlay.nodeCount(), 0, 'a node naming an input is dropped on read');
    same(overlay.pinOf(src.id), null, 'and its position goes with it');
    same(overlay.sizeOf(src.id), 0, 'and its width');
    same(overlay.insertCount(), 0, 'and what was spliced onto its own pads');

    // Its id goes out of circulation too, which is the whole reason the
    // arrangement above cannot be left behind: a blob is read on a run whose
    // counter starts at one.
    overlay.clear();
    localStorage.setItem('ffmpeg-bro.graph', JSON.stringify({
        inserts: [], nodes: [{ id: 'u9000', kind: 'input', input: 'in3' }],
        wires: [], cuts: [], locks: {}, sizes: {}, pins: {},
    }));
    overlay.restore();
    same(overlay.addNode('hflip').id, 'u9001',
         'the id of a node dropped on read is still taken out of circulation');

    // ...and the blob this application has in fact been writing: the node was
    // dropped by an earlier run and the state remembered without it, leaving a
    // pin naming nothing at all. A user node's id is `u<n>` and nothing else in
    // this file is shaped like one — every anchor carries a `/` or a `:` — so
    // one naming no record is a card that has gone.
    overlay.clear();
    overlay.unpinAll();
    localStorage.setItem('ffmpeg-bro.graph', JSON.stringify({
        inserts: [], nodes: [], wires: [], cuts: [], locks: {},
        sizes: { u85: 300 },
        pins: { u82: { x: 37, y: 778 }, 'clip:3/scale': { x: 1, y: 2 } },
    }));
    overlay.restore();
    same(overlay.pinOf('u82'), null, 'an orphaned pin is dropped');
    same(overlay.sizeOf('u85'), 0, 'and an orphaned width');
    same(overlay.pinOf('clip:3/scale').x, 1,
         'while one on a derived node is kept — its anchor names a node the next ' +
         'derivation makes again');

    // And `Clear my filters and locks`, which keeps the arrangement — but only
    // where it can still mean something. A pin held by an anchor names a node
    // the next derivation makes again; one held by a node of yours names
    // something Clear has just thrown away, and it is what put the two pins
    // with no nodes anywhere near them into this checkout's own blob.
    overlay.clear();
    overlay.unpinAll();
    const mine = overlay.addNode('hflip');
    overlay.setPin(mine.id, 8, 9);
    overlay.setPin('clip:3/scale', 400, 90);
    overlay.clear();
    same(overlay.pinOf(mine.id), null, 'Clear takes the position of a node it cleared');
    ok(!!overlay.pinOf('clip:3/scale'),
       'and keeps the one on a derived node, which is still going to be there');

    overlay.clear();
    overlay.unpinAll();
    const gone = overlay.addSource('in7');
    overlay.setPin(gone.id, 12, 34);
    overlay.retain([], []);
    same(overlay.sourceInputs().length, 0, 'a source whose input has gone is dropped');
    same(overlay.pinOf(gone.id), null, 'and takes its position with it');
    overlay.clear();
    overlay.unpinAll();
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

    // **And so is the printed one.** Both halves of `filtergraph.js` refuse,
    // and only one of them was ever asked to: `renderGraph()` produces
    // something that will be run here and `filtergraph()` produces something
    // somebody is invited to paste into a shell, which is the same obligation
    // one machine over. The whole argument for printing a command is that it
    // can be taken elsewhere and run, and a chain list for a graph libavfilter
    // would reject is that argument breaking.
    {
        const printed = globalThis.__ffmpegBro.filtergraph(
            oneClip(), null, { overlay: overlay.current() });
        same(printed.ok, false, 'the command bar refuses it too, rather than printing chains');
        ok(Array.isArray(printed.problems) && printed.problems.length > 0 && !!printed.graph,
           'carrying the problems and the graph, so the stage can mark the node');
        same(printed.reason, printed.problems[0].reason,
             `and the reason it gives is the first of them: ${printed.reason}`);
        ok(printed.problems.some((p) => /video out|overlay/.test(p.reason)),
           'which are about the pad the cut left empty');
        ok(!printed.chains, 'with no chains on it at all');
    }

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

    // ── an input whose pictures start out on a card ────────────────────────
    //
    // **The preview's tail is `scale`, which reads pixels.** A clip opened with
    // `-hwaccel cuda -hwaccel_output_format cuda` hands the graph a device
    // handle at `[0:v]`, so a preview of *that node* has to bring it down
    // first — and it did not, because this file walked the wires for an
    // `hwupload` and knew nothing about an input that was already up. What came
    // back was libavfilter's four hundred pixel format names, from the one
    // stage in this application whose whole job is to explain that message.
    //
    // Written against a hand-made spec rather than a machine with a card in it,
    // for the reason the rest of this file is: where the picture starts out is
    // a fact the derivation writes onto the input node out of `spec.inputs`,
    // and asserting on it needs no device to exist.
    {
        const spec = oneClip({ input: 0 });
        spec.inputs = [{ path: 'a.mp4', hwaccel: 'cuda', hwaccelOutputFormat: 'cuda' }];
        const up = derive(spec);
        const node = up.graph.byAnchor('clip:7/in');
        ok(node.onDevice === true,
           'the derivation records that this -i keeps its pictures on the card');

        const shown = previewGraph(up.graph, node, { fit: 160 });
        ok(shown.ok && /^\[0:v\]hwdownload,format=nv12\[hwdl\];\[hwdl\]scale=/
            .test(shown.filterGraph),
           `so its own card brings them down before the fit: ${shown.filterGraph}`);

        // And exactly once. The derivation puts an `hwdownload` at the head of
        // the clip's chain already, so every node past it is looking at a
        // picture in system memory and a second download would be a filter that
        // libavfilter refuses outright.
        const after = previewGraph(up.graph, up.graph.byAnchor('clip:7/trim'), { fit: 160 });
        same(after.filterGraph.split('hwdownload').length - 1, 1,
             'and a node below the derivation’s own hwdownload does not download twice');

        // The same input with no `-hwaccel` in front of the output format is
        // not on a card: `-hwaccel_output_format` names the format a *device's*
        // frames come back as and means nothing without one. Asked in one place
        // now, so the graph and the printed command cannot answer differently.
        const half = oneClip({ input: 0 });
        half.inputs = [{ path: 'a.mp4', hwaccelOutputFormat: 'cuda' }];
        same(derive(half).graph.byAnchor('clip:7/in').onDevice, false,
             'an output format with no -hwaccel in front of it is not a device');
    }

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

// ── enable=: a filter that is on for part of the render ────────────────────
//
// ffmpeg's timeline support, and the nearest thing it has to a keyframe. The
// whole design rests on one claim — that the strip and the text are one
// mechanism — so the check that matters is the round trip: what the control
// writes is what the parser reads back, and what the parser cannot read is
// left exactly as it was found rather than approximated.

console.log('\nenable=, as spans and as text');
{
    const { supportsTimeline, parseEnable, printEnable } = globalThis.__ffmpegBro.graph;

    // Which filters can take one is a registry fact — AVFILTER_FLAG_SUPPORT_-
    // TIMELINE arrives as `f.timeline` — and not a list anybody writes down.
    ok(supportsTimeline('hflip'), 'libavfilter says hflip honours a timeline');
    ok(supportsTimeline('eq'), 'and so does eq');
    ok(!supportsTimeline('scale'), 'and says scale does not');
    ok(!supportsTimeline('trim'), 'nor trim');

    const round = (text, what) => {
        const p = parseEnable(text);
        ok(p.ok, `${what} parses`);
        same(printEnable(p.spans), `'${text}'`, `${what} round-trips unchanged`);
    };
    round('between(t,1,2)', 'a span');
    round('between(t,1,2)+between(t,5,6)', 'several spans');
    round('gt(t,3)', 'from a moment');
    round('lt(t,4.5)', 'until a moment');
    // `gte` is kept as `gte` rather than printed as `gt`: they are different
    // expressions and rewriting one as the other is a rewrite of somebody's
    // text, which is what this whole surface exists not to do.
    round('gte(t,2)+lte(t,9)', 'the closed forms, as themselves');
    round('gt(t,1)+between(t,4,5)', 'a mixture');

    // The quotes are part of the value, because a filtergraph separates filters
    // with commas — so both spellings have to read the same way in.
    same(printEnable(parseEnable("'between(t,1,2)'").spans), "'between(t,1,2)'",
         'a quoted value reads as the span it is');
    same(parseEnable('').spans.length, 0, 'nothing at all is “always on”');
    same(printEnable([]), '', 'and always on writes nothing, not an empty expression');

    // What it cannot draw. Each is a legitimate `enable` and each has to come
    // back as a refusal with a reason rather than as an approximation.
    for (const [text, why] of [
        ['mod(t,2)', 'an expression'],
        ['between(n,10,20)', 'a frame count'],
        ['gt(pos,1000)', 'a byte position'],
        ['between(t,1+1,4)', 'arithmetic inside a span'],
        ['between(t,1,2)*gt(t,0)', 'terms multiplied rather than added'],
        ['if(gt(t,1),1,0)', 'a conditional'],
    ]) {
        const p = parseEnable(text);
        ok(!p.ok && !!p.reason, `${why} is refused, with a reason: ${p.reason}`);
    }

    // A span that is not a span. `between(t,2,2)` is a filter that is never on
    // and a strip cannot draw it either way round.
    ok(!parseEnable('between(t,2,2)').ok, 'a span of no length is not a span');

    // Whether it is on at an instant, which is what the playback readout says
    // while a node runs. The comparisons are ffmpeg's own — `between` is
    // inclusive at both ends, `gt` is strict, `gte` is not — because a boundary
    // decided one way here and another way in libavfilter is wrong on exactly
    // the frame somebody is looking at.
    const on = (text, t) => globalThis.__ffmpegBro.graph
        .isOnAt(parseEnable(text).spans, t);
    ok(on('', 5), 'a filter with no enable is on always');
    ok(!on('between(t,1,2)', 0.9), 'and one with a span is off before it');
    ok(on('between(t,1,2)', 1), 'on at the near edge, which between() includes');
    ok(on('between(t,1,2)', 2), 'on at the far edge too');
    ok(!on('between(t,1,2)', 2.1), 'and off after it');
    ok(!on('gt(t,3)', 3), 'gt is strict at its boundary');
    ok(on('gte(t,3)', 3), 'and gte is not');
    ok(on('between(t,1,2)+gt(t,8)', 9), 'and several spans are an or, as the + says');
}

// ── the gesture ────────────────────────────────────────────────────────────
//
// Everything above is the model, which is where the rules live. This is the
// part a person actually does: press on a socket, drag, let go on another one.
// It needs an edit — sockets have to be somewhere before a wire can be dragged
// between them — so it is skipped without a media file, which is also what
// keeps this suite runnable by hand with nothing to hand.
//
// The events are real `MouseEvent`s dispatched on the elements a pointer would
// reach: mousedown on the socket itself, and mousemove/mouseup on `<body>`,
// which bubbles to `document` where the view listens. That is the route a real
// drag takes, and the reason the coordinates below are computed from
// `graphPlacement()` rather than hard-coded is that a layout this test does not
// compute is a layout it cannot make assertions about.

const media = (globalThis.scriptArgs || []).filter((a) => a !== '--')[0];

if (!media) {
    console.log('\nthe wiring gesture — skipped, no media file given');
} else {
    console.log('\nthe wiring gesture, on the real stage');
    const A = globalThis.__ffmpegBro;
    overlay.clear();
    dropFiles(400, 300, [media]);
    waitFor('a clip on the timeline', () => A.project.clips.length === 1);
    ok(A.shell.goTo('graph'), 'the Graph stage opens');
    pump(400);
    A.graph.draw();
    pump(200);

    const vp = document.getElementById('gr-viewport');
    const clipId = A.project.clips[0].id;
    const keyOfBox = (b) => (b.node.derived ? b.node.anchor : b.node.id);
    const boxOf = (key) => (A.graph.placement().nodes || []).find((b) => keyOfBox(b) === key);
    /// Where a socket is on the screen — the same arithmetic `portY` does, which
    /// is the one formula the wire, the dot and the hit test all share.
    const screenOf = (box, dir, port) => {
        const P = A.graph.placement();
        const r = vp.getBoundingClientRect();
        const ports = dir === 'in' ? box.inPorts : box.outPorts;
        const y = box.y + (box.h * (port + 1)) / (Math.max(1, ports) + 1);
        const x = dir === 'in' ? box.x : box.x + box.w;
        return { x: x * P.zoom + P.panX + r.left, y: y * P.zoom + P.panY + r.top };
    };
    const mouse = (type, at, target) => (target || document.body).dispatchEvent(
        new MouseEvent(type, { bubbles: true, button: 0,
                               clientX: Math.round(at.x), clientY: Math.round(at.y) }));
    /// A click is three events, and the middle two matter: the view swallows the
    /// click that ends a drag — a rubber band finishes with one, and letting it
    /// through would clear the selection the band had just made — so a press and
    /// release have to happen before the click for the click to count.
    const click = (at, target) => {
        mouse('mousedown', at, target);
        mouse('mouseup', at);
        mouse('click', at, target);
    };
    const sockOf = (key, dir, port) =>
        document.querySelector(`#gr-nodes [data-key="${key}"] ` +
                               `.gn-sock[data-dir="${dir}"][data-port="${port}"]`);

    ok(!!boxOf(`clip:${clipId}/format`), 'the graph is drawn and the cards are placed');

    // **A socket per pad the filter has**, not per wire that arrived. The
    // compositing overlay reads two and both are on the card whether or not
    // anything is on them, which is what makes an empty pad a thing you can see
    // and aim at.
    {
        const over = `composite/overlay:${clipId}`;
        same(document.querySelectorAll(`#gr-nodes [data-key="${over}"] .gn-sock-in`).length, 2,
             'overlay draws two input sockets');
        same(boxOf(over).inPorts, 2, 'and the layout spaces the wires over the same two');
        // The hit test works from the layout rather than from the document,
        // because the cards live in a container with a transform on it and an
        // eight-pixel dot at 0.6x is a target nobody can hit.
        const at = screenOf(boxOf(over), 'in', 1);
        const r = vp.getBoundingClientRect();
        const hit = socketAt(A.graph.placement(), at.x - r.left, at.y - r.top,
                             { zoom: A.graph.placement().zoom, panX: A.graph.placement().panX,
                               panY: A.graph.placement().panY });
        ok(hit && hit.dir === 'in' && hit.port === 1 && keyOfBox(hit) === over,
           'and a point on one finds that pad and no other');
    }

    // Let a wire go over empty canvas and the palette opens on what can take it.
    console.log('\nlet go over nothing and pick a filter');
    {
        const from = `clip:${clipId}/format`;
        const sock = sockOf(from, 'out', 0);
        ok(!!sock, 'a socket is a real element with its pad written on it');
        const start = screenOf(boxOf(from), 'out', 0);
        const r = vp.getBoundingClientRect();
        // Somewhere with nothing on it: below everything the layout drew.
        const empty = { x: r.left + 60, y: r.top + r.height - 30 };
        mouse('mousedown', start, sock);
        mouse('mousemove', empty);
        mouse('mouseup', empty);
        pump(120);

        ok(!!document.querySelector('#gr-panel [data-f="padsearch"]'),
           'the palette opens on the pad the wire came from');
        const offered = document.querySelector('#gr-panel [data-filter="overlay"]');
        ok(!!offered, 'and offers a two-input filter — which is the whole point, since ' +
                      'there is no wire one of those could be spliced onto');
        offered.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(200);

        same(overlay.nodeCount(), 1, 'clicking it places the node');
        const made = overlay.nodes()[0];
        same(made.filter, 'overlay', 'as the filter you chose');
        ok(!!overlay.pinOf(made.id), 'where you let go');
        same(overlay.wires().length, 1, 'wired to the pad you dragged from');
        same(overlay.wires()[0].from, from, 'by its key, which survives a rebuild');
        // `overlay` reads a picture on both pads, so the first free one is 0 —
        // what matters is that the port is chosen from libavfilter's pad list
        // rather than assumed, since a sound wire would have to land elsewhere.
        same(overlay.wires()[0].to, made.id, 'and arriving on the node that was made');
    }

    // ...and now socket to socket, which is the gesture proper.
    console.log('\nsocket to socket');
    {
        const made = overlay.nodes()[0];
        A.graph.draw();
        pump(200);
        const target = boxOf(`composite/overlay:${clipId}`);
        const source = boxOf(made.id);
        ok(!!target && !!source, 'both cards are on the screen');

        const start = screenOf(source, 'out', 0);
        const end = screenOf(target, 'in', 1);
        mouse('mousedown', start, sockOf(made.id, 'out', 0));
        mouse('mousemove', { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
        mouse('mousemove', end);
        mouse('mouseup', end);
        pump(200);

        const wire = overlay.wires().find((w) => w.from === made.id);
        ok(!!wire, 'a wire is made between the two sockets');
        same(wire.to, `composite/overlay:${clipId}`, 'ending on the node it was dropped on');
        same(wire.port, 1, 'and on the pad — not on whichever one came first');

        // An input pad holds one wire, so dropping on an occupied pad replaces
        // what was there. That is what makes putting a filter *between* two
        // derived nodes one gesture rather than a delete and two connects.
        const d = derive(A.exporter.buildSpec(), null, { overlay: overlay.current() });
        const into = d.graph.byAnchor(`composite/overlay:${clipId}`);
        same(d.graph.inEdges(into).filter((e) => e.port === 1).length, 1,
             'the derived wire it replaced is gone rather than doubled');
        same(d.graph.producers(into)[1].id, made.id, 'and what arrives there is yours');
    }

    // A wire is a thing you can select and delete, which is the other half of
    // being able to make one.
    console.log('\nclick a wire, delete a wire');
    {
        const P = A.graph.placement();
        const r = vp.getBoundingClientRect();
        const made = overlay.nodes()[0];
        const wire = P.wires.find((w) => w.edge.from === made.id);
        ok(!!wire, 'the wire is drawn');
        const mid = { x: ((wire.x1 + wire.x2) / 2) * P.zoom + P.panX + r.left,
                      y: ((wire.y1 + wire.y2) / 2) * P.zoom + P.panY + r.top };
        click(mid, vp);
        pump(120);
        ok(!!document.querySelector('#gr-panel [data-f="unwire"]'),
           'clicking it selects it, and the column says what it is');

        const before = overlay.wires().length;
        document.body.dispatchEvent(new KeyboardEvent('keydown',
                                                      { key: 'Delete', bubbles: true }));
        pump(200);
        same(overlay.wires().length, before - 1, 'and Delete cuts it');
    }

    // Cutting a derived wire is a different act from forgetting one of yours,
    // because the skeleton grows the derived one back on every rebuild.
    console.log('\ncutting a derived wire');
    {
        overlay.clear();
        A.graph.draw();
        pump(200);
        const P = A.graph.placement();
        const r = vp.getBoundingClientRect();
        const sinkBox = boxOf('out:v');
        const wire = P.wires.find((w) => w.edge.to === sinkBox.node.id);
        const mid = { x: ((wire.x1 + wire.x2) / 2) * P.zoom + P.panX + r.left,
                      y: ((wire.y1 + wire.y2) / 2) * P.zoom + P.panY + r.top };
        click(mid, vp);
        pump(120);
        document.body.dispatchEvent(new KeyboardEvent('keydown',
                                                      { key: 'Delete', bubbles: true }));
        pump(200);
        ok(overlay.isCut('out:v', 0), 'the absence is written down, not merely not written');
        const d = derive(A.exporter.buildSpec(), null, { overlay: overlay.current() });
        ok(d.problems.some((p) => /nothing is wired to video out/.test(p.reason)),
           'the stage says what is missing');
        // ...and it is on the card, where the person is looking, rather than
        // only in the bar along the bottom.
        A.graph.draw();
        pump(200);
        ok(!!document.querySelector('#gr-nodes .gn-bad'),
           'the node it is about is marked');
        ok(document.querySelectorAll('#gr-nodes .gn-sock-open').length > 0,
           'and the pad with nothing on it is drawn as empty rather than not drawn');

        overlay.clear();
        A.graph.draw();
        pump(120);
        same(document.querySelectorAll('#gr-nodes .gn-bad').length, 0,
             'and putting it back clears the marks');
    }

    // A source is placed the same way a filter is, because a source *is* a
    // filter — one with no inputs, which libavfilter says and nothing here
    // writes down. What that makes reachable is the watermark.
    console.log('\nplacing a source');
    {
        overlay.clear();
        A.graph.draw();
        pump(200);
        document.getElementById('gr-add').dispatchEvent(
            new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(160);
        ok(!!document.querySelector('#gr-panel [data-f="padsearch"]'),
           'Add node opens the palette over the canvas');
        ok(!!document.querySelector('#gr-panel [data-filter="testsrc"]'),
           'and it offers what libavfilter makes out of nothing');

        const inputId = A.inputs.inputs[0].id;
        const offered = document.querySelector(`#gr-panel [data-input="${inputId}"]`);
        ok(!!offered, 'led by the files already loaded, because a file the graph reads is ' +
                      'an -i with a demuxer and a window and not a movie= argument');

        offered.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(300);
        same(overlay.sourceInputs().join(), inputId, 'clicking one places it');
        const rec = overlay.nodes()[0];
        ok(!!boxOf(rec.id), 'and its card is on the screen');
        const padText = document.querySelector(
            `#gr-nodes [data-key="${rec.id}"] .gn-pad`);
        ok(padText && /\[1:v\]/.test(padText.textContent),
           `numbered after the clip's own input, which is what the chains say: ${
               padText ? padText.textContent : 'no pad'}`);

        // **The Sources stage has to stay true.** It claims to be every file
        // this render opens, and an input with no clip cut from it is now an
        // ordinary thing for a render to open.
        A.drawSources();
        pump(120);
        const card = document.querySelector(`#src-list [data-input="${inputId}"] .src-used`);
        ok(card && /read by the graph/.test(card.textContent),
           `the Sources card says the graph reads it: ${card ? card.textContent : 'no card'}`);
        const remove = document.querySelector('#src-detail [data-f="srcremove"]');
        ok(remove && remove.disabled,
           'and it cannot be removed out from under the node that names it');

        // A `movie` filter is not an input, and that is exactly why it is
        // accounted for separately rather than left off the list.
        overlay.addNode('movie', { pos: ['C\\:/logo.png'] });
        A.drawSources();
        pump(120);
        const adopt = document.querySelector('#src-list [data-f="srcadopt"]');
        ok(!!adopt, 'a movie node’s file is listed as opened by the graph, with the offer ' +
                    'to make it an input that has a demuxer and a window of its own');

        overlay.clear();
        A.graph.draw();
        pump(160);
    }

    // ── the When strip ─────────────────────────────────────────────────────
    //
    // The claim being checked is that the strip and the `enable` text are one
    // mechanism. So every assertion below reads the *stored parameter* after a
    // gesture on the strip, and the last of them types an expression the strip
    // cannot draw and checks that nothing rewrote it.
    console.log('\nwhen a filter is on');
    {
        const { parseEnable } = A.graph;
        const spec = A.exporter.buildSpec();
        const length = spec.end - spec.start;
        overlay.clear();
        const rec = overlay.insert(`clip:${clipId}/after-scale`, 'hflip');
        A.graph.draw();
        pump(200);

        const card = document.querySelector(`#gr-nodes [data-key="${rec.id}"]`);
        ok(!!card, 'the filter is on the stage');
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(160);

        const add = document.querySelector('#gr-panel [data-f="addspan"]');
        ok(!!add, 'the column offers to turn it on for a span');
        add.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(200);

        const enableOf = () => overlay.inserts()[0].params.enable || '';
        ok(/^'between\(t,[\d.]+,[\d.]+\)'$/.test(enableOf()),
           `one click writes one span, quoted: ${enableOf()}`);
        same(document.querySelectorAll('#gr-panel .when-span').length, 1,
             'and the strip draws exactly what the expression says');
        // The card states it too, because a filter that runs for part of the
        // render is a different filter from one that runs throughout.
        ok(!!document.querySelector(`#gr-nodes [data-key="${rec.id}"] .gn-when`),
           'the card says when it is on');

        document.querySelector('#gr-panel [data-f="addspan"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(200);
        const two = parseEnable(enableOf());
        same(two.spans.length, 2, `a second span is added rather than replacing the first: ${
            enableOf()}`);
        ok(enableOf().indexOf('+') > 0, 'written the way ffmpeg writes an or — with a +');
        same(document.querySelectorAll('#gr-panel .when-span').length, 2,
             'and both are on the strip');

        // Dragging an end is the same mechanism: it prints an expression and
        // puts it where the text field would have put it. Committed on release
        // and not on every move, because a write locks the node and rebuilds
        // the strip under the hand holding it.
        {
            const track = document.querySelector('#gr-panel .when-strip .when-track');
            const grip = track.querySelector('[data-drag="0:from"]');
            ok(!!grip, 'the near end of the first span has a grip');
            const box = track.getBoundingClientRect();
            const y = box.top + box.height / 2;
            const at = (f) => ({ x: box.left + box.width * f, y });
            mouse('mousedown', at(0.05), grip);
            mouse('mousemove', at(0.2));
            mouse('mouseup', at(0.2));
            pump(200);
            const moved = parseEnable(enableOf());
            ok(moved.ok, `it still parses after a drag: ${enableOf()}`);
            ok(Math.abs(moved.spans[0].from - length * 0.2) < length * 0.06,
               `and the end went where it was dragged (${moved.spans[0].from.toFixed(2)}s of ` +
               `${length.toFixed(2)}s)`);
        }

        // **A press that moved nothing writes nothing.** The strip is a
        // reading of the expression, and `printEnable(parseEnable(text))` is
        // not the text — `between(t,1.00,2.00)` comes back `between(t,1,2)` —
        // so a bare click on a span rewrote what somebody had typed, and on a
        // derived node it wrote a lock that outranks the edit for ever after.
        {
            const field = document.querySelector('#gr-panel [data-f="enable"]');
            field.value = "'between(t,1.00,2.00)'";
            field.dispatchEvent(new Event('change', { bubbles: true }));
            pump(200);
            same(enableOf(), "'between(t,1.00,2.00)'",
                 'an expression is stored exactly as it was typed');

            const track = document.querySelector('#gr-panel .when-strip .when-track');
            const grab = track.querySelector('[data-span="0"]');
            ok(!!grab, 'the span has a body to press on');
            const box = track.getBoundingClientRect();
            const at = { x: box.left + box.width * 0.5, y: box.top + box.height / 2 };
            mouse('mousedown', at, grab);
            mouse('mouseup', at);
            pump(200);
            same(enableOf(), "'between(t,1.00,2.00)'",
                 'and a press that dragged nothing leaves it exactly as it was');
        }

        // **An expression the control cannot draw is not rewritten.** This is
        // the honest failure the whole surface turns on: the strip stands down,
        // says which part it gave up on, and the text stays as it was typed.
        {
            const field = document.querySelector('#gr-panel [data-f="enable"]');
            ok(!!field, 'the expression itself is editable, under the strip');
            field.value = "'lt(mod(t,4),2)'";
            field.dispatchEvent(new Event('change', { bubbles: true }));
            pump(200);
            same(enableOf(), "'lt(mod(t,4),2)'",
                 'an expression the strip cannot draw is stored exactly as typed');
            same(document.querySelectorAll('#gr-panel .when-span').length, 0,
                 'the strip draws nothing rather than drawing something wrong');
            ok(!!document.querySelector('#gr-panel .gp-problem'),
               'and says so, where somebody is about to reach for the control');
            // The card cannot draw it either, and says the same thing.
            const bar = document.querySelector(`#gr-nodes [data-key="${rec.id}"] .gn-when-raw`);
            ok(!!bar, 'the card marks it as an expression rather than a span');
            // Nothing was lost: the same text is still what the node renders
            // with, so a graph that has been round-tripped through the strip is
            // the graph that was typed.
            const d = derive(A.exporter.buildSpec(), null, { overlay: overlay.current() });
            const node = d.graph.node(rec.id);
            same(node.params.enable, "'lt(mod(t,4),2)'", 'and the graph carries it verbatim');
        }

        // Back to something drawable, and off again.
        {
            const field = document.querySelector('#gr-panel [data-f="enable"]');
            field.value = "'between(t,0.5,1.5)'";
            field.dispatchEvent(new Event('change', { bubbles: true }));
            pump(200);
            same(document.querySelectorAll('#gr-panel .when-span').length, 1,
                 'typing a span by hand draws it — the field and the strip are one thing');
            document.querySelector('#gr-panel [data-f="always"]')
                .dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
            pump(200);
            same(overlay.inserts()[0].params.enable, undefined,
                 'and “always on” takes the option off rather than storing an empty one');
        }
    }

    // ── judging one ────────────────────────────────────────────────────────
    //
    // A still cannot answer "does it come on where I meant it to" — only a run
    // of seconds can, which is what the play button on a card is for. What that
    // needs from this chunk is two things: the clock a played piece renders on
    // has to be the render's, not the piece's, and the readout has to say which
    // side of the boundary the frame on screen is on.
    console.log('\nplaying a node whose filter comes and goes');
    {
        overlay.clear();
        const rec = overlay.insert(`clip:${clipId}/after-scale`, 'hflip');
        A.graph.draw();
        pump(200);

        // A piece of a playback is a render of two seconds out of the middle of
        // the range, and it is derived with `origin` so that `t` still means
        // time into the render. Checked on the graph rather than through a
        // rendered file: the offset is the whole mechanism and it is visible in
        // the setpts of every chain.
        const spec = A.exporter.previewSpec({ start: 4, end: 6 });
        same(spec.origin, 0, 'a preview spec carries where the render’s clock starts');
        const d = derive(spec, null, { overlay: overlay.current() });
        const shifted = d.graph.byAnchor(`clip:${clipId}/setpts`);
        ok(/\+4\/TB/.test(shifted.pos[0]),
           `a window four seconds in is put four seconds along: ${shifted.pos[0]}`);
        ok(/\+4\/TB/.test(d.graph.byAnchor('base/setpts').pos[0]),
           'and the canvas it is composited against goes with it');
        // Without one — which is what a spec written by hand has — nothing
        // moves, so an export is exactly what it was.
        const plain = derive(A.exporter.previewSpec({ start: 4, end: 6, origin: 4 }), null,
                             { overlay: overlay.current() });
        same(plain.graph.byAnchor('base/setpts'), null,
             'a window that is its own origin is shifted by nothing at all');

        const enableOf = () => overlay.inserts()[0].params.enable || '';
        const play = (key) => document.querySelector(`#gr-nodes [data-play="${key}"]`);
        const clockText = () => {
            const c = document.querySelector('#gr-nodes .gn-playbar .gn-clock');
            return c ? c.textContent : '';
        };

        // Carried on the card, because the readout is written on the frame loop
        // and re-deriving a graph to answer it would derive sixty times a second.
        for (const [text, want] of [["'lt(t,1000)'", ' · on'], ["'gt(t,1000)'", ' · off']]) {
            overlay.edit({ id: rec.id, derived: false }, { params: { enable: text } });
            A.graph.draw();
            pump(200);
            same(document.querySelector(`#gr-nodes [data-key="${rec.id}"]`)
                     .getAttribute('data-enable'), text,
                 `the card carries ${text}, which is what the readout reads`);
            // The play button only exists once the node has a picture: it is
            // drawn over the still, and a card with nothing in it has nothing
            // to press play on.
            waitFor('the node’s own picture', () => !!play(rec.id), 20000);
            play(rec.id).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
            waitFor('the playback readout', () => /·/.test(clockText()), 15000);
            ok(clockText().indexOf(want) >= 0,
               `and while it plays the card says${want}: “${clockText()}”`);
            const stop = play(rec.id);
            if (stop) stop.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
            pump(200);
        }
        same(enableOf(), "'gt(t,1000)'", 'and nothing about playing it changed what it says');
        overlay.clear();
        A.graph.draw();
        pump(160);
    }

    // A filter libavfilter says has no timeline support is not offered one.
    // Refused rather than ignored: `set_enable_expr` checks the flag and hands
    // back AVERROR_PATCHWELCOME, so a graph carrying one never builds.
    console.log('\na filter that cannot take a timeline');
    {
        overlay.clear();
        A.graph.draw();
        pump(200);
        const key = `clip:${clipId}/scale`;
        const card = document.querySelector(`#gr-nodes [data-key="${key}"]`);
        ok(!!card, 'the derived scale is on the stage');
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(160);
        same(document.querySelectorAll('#gr-panel .when-strip').length, 0,
             'no strip is offered for it');
        same(document.querySelectorAll('#gr-panel [data-f="enable"]').length, 0,
             'and no field either — a control that cannot work is worse than none');
        const column = document.getElementById('gr-panel').textContent;
        ok(/no timeline support/.test(column),
           'the column says why, rather than leaving a gap where a control was');

        // Set one anyway — through a lock, which is the raw path — and the
        // graph refuses before the render does.
        const d0 = derive(A.exporter.buildSpec(), null, { overlay: overlay.current() });
        overlay.edit(d0.graph.byAnchor(key), { params: { enable: "'between(t,0,1)'" } });
        const d = derive(A.exporter.buildSpec(), null, { overlay: overlay.current() });
        ok(d.problems.some((p) => p.key === key && /no timeline support/.test(p.reason)),
           'and setting it by hand is reported against that node, not left to the render');
        overlay.clear();
        A.graph.draw();
        pump(160);
    }

    // ── the column, across a redraw nobody asked for ───────────────────────
    //
    // Values in the column commit on `change`, deliberately, because
    // committing on `input` locks the node between keystrokes. So what has
    // been typed and not yet committed is not in the model — and this column
    // is rebuilt whole on every derivation, including the ones nothing on
    // screen asked for: a node preview finishing a second later rebuilds the
    // stage while somebody is half way through a number.
    console.log('\nthe column keeps the field being typed into');
    {
        overlay.clear();
        A.graph.draw();
        pump(200);
        const key = `clip:${clipId}/scale`;
        const card = document.querySelector(`#gr-nodes [data-key="${key}"]`);
        ok(!!card, 'the derived scale is on the stage');
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(160);

        const field = () => document.querySelector('#gr-panel [data-pos="0"]');
        ok(!!field(), 'and its width is a field in the column');
        field().value = 'iw*0.5';
        field().focus();
        pump(20);

        A.graph.draw();
        pump(200);
        same(field().value, 'iw*0.5',
             'a redraw nobody asked for leaves what is half typed where it was');
        same(overlay.lockCount(), 0,
             'and it is still uncommitted — nothing was written to the model');

        field().dispatchEvent(new Event('change', { bubbles: true }));
        pump(200);
        same(overlay.lockCount(), 1, 'committing it locks the node, as typing anywhere does');
        ok(!!field() && field().value === 'iw*0.5',
           'and the field is still the one in hand, carrying what was typed');
        overlay.clear();
        A.graph.draw();
        pump(160);
    }

    // ── a range that is the absence of one ─────────────────────────────────
    //
    // libav gives every unbounded numeric option the whole of its type as a
    // range, so an int32 option reports ±2147483648. That is not a range and
    // printing it at that length pushes the column about for no information.
    // The option columns suppress it and this one had its own copy of the rule
    // with a threshold three orders of magnitude higher, so the same option
    // read one way on the Encode stage and another on the Graph stage.
    console.log('\na range that is the absence of one');
    {
        overlay.clear();
        A.graph.draw();
        pump(200);
        // A filter with an int32 option in it, found rather than named: what
        // matters is that some option in this build reports ±2147483648, which
        // is the shape the two thresholds disagreed about.
        const wide = (bro.ffmpeg.filters || []).find((flt) => {
            if (flt.inputs !== 'v' || flt.outputs !== 'v') return false;
            let opts = [];
            try { opts = bro.ffmpeg.filterOptions(flt.name) || []; } catch (e) { return false; }
            return opts.some((o) => o.hasRange && o.type !== 'enum' && o.type !== 'flags' &&
                                    Math.abs(Number(o.min)) > 1e9 &&
                                    Math.abs(Number(o.min)) < 1e15 &&
                                    Math.abs(Number(o.max)) > 1e9 &&
                                    Math.abs(Number(o.max)) < 1e15);
        });
        ok(!!wide, `${wide ? wide.name : 'no filter'} reports an option whose range is its ` +
                   'whole type');
        const rec = overlay.insert(`clip:${clipId}/after-scale`, wide.name);
        A.graph.draw();
        pump(200);
        const card = document.querySelector(`#gr-nodes [data-key="${rec.id}"]`);
        ok(!!card, 'it is on the stage');
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(160);
        const search = document.querySelector('#gr-panel [data-f="optsearch"]');
        ok(!!search, 'the column searches the filter’s whole option table');

        // Everything it has, so that what is asserted is a property of the
        // column rather than of one option somebody picked.
        search.value = 'a';
        search.dispatchEvent(new Event('input'));
        pump(120);
        const ranges = Array.from(document.querySelectorAll('#gr-panel .opt-range'))
                            .map((n) => n.textContent).filter(Boolean);
        const huge = ranges.filter((t) => /\d{10,}/.test(t));
        same(huge.length, 0,
             `no option here prints its whole type as a range (${ranges.length} shown` +
             `${huge.length ? ': ' + huge.join(' ') : ''})`);
        overlay.clear();
        A.graph.draw();
        pump(160);
    }

    // ── a `+` opened on a wire that then goes away ─────────────────────────
    //
    // `derive()` rebuilds its list of insert points from scratch every time,
    // and a point is the one kind of selection that can stop existing while it
    // is open: the clip it names is one edit away from not being in the graph.
    // Held as an object, the palette went on offering filters for a wire that
    // was not there, and picking one recorded an insert against an anchor no
    // derivation declares — skipped without a word, stuck in the overlay for
    // ever, and reading as an edit that went to nothing.
    console.log('\nan insert point whose wire has gone');
    {
        overlay.clear();
        A.project.clips[0].muted = false;
        A.graph.draw();
        pump(200);

        // The clip's sound, leaving its input node by the second pad — one `-i`
        // with a picture pad and a sound pad, which is what a file is here.
        const P = A.graph.placement();
        const r = vp.getBoundingClientRect();
        const from = boxOf(`clip:${clipId}/in`);
        const w = P.wires.find((x) => x.edge.from === from.node.id &&
                                      (x.edge.fromPort || 0) === 1);
        ok(!!w, 'the wire carrying the clip’s sound is drawn');
        const mid = { x: ((w.x1 + w.x2) / 2) * P.zoom + P.panX + r.left,
                      y: ((w.y1 + w.y2) / 2) * P.zoom + P.panY + r.top };
        mouse('mousemove', mid);
        pump(120);
        const plus = document.querySelector('#gr-nodes .gp-plus');
        ok(!!plus, 'hovering it offers a +');
        plus.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        pump(160);
        ok(!!document.querySelector('#gr-panel [data-f="filtersearch"]'),
           'clicking it opens the palette for that point');
        ok(document.getElementById('gr-panel').textContent.indexOf('clip audio') >= 0,
           'and the column names the point it is about');

        // Now take the wire away with the `+` still open. Muting the clip is
        // the shortest way: there is no sound to put a filter on any more.
        A.project.clips[0].muted = true;
        A.graph.draw();
        pump(200);
        same(document.querySelectorAll('#gr-panel [data-f="filtersearch"]').length, 0,
             'the palette stands down rather than offering filters for a wire that has gone');
        ok(!!document.querySelector('#gr-panel [data-f="pointgone"]'),
           'and says so, rather than blanking itself');
        same(overlay.insertCount(), 0, 'nothing was recorded against it');

        A.project.clips[0].muted = false;
        overlay.clear();
        A.graph.draw();
        pump(160);
    }

    // ── every card has something to say ────────────────────────────────────
    //
    // The previews are taken over two seconds and the graph is drawn over the
    // whole range, so a timeline longer than the window has cards on it for
    // clips that window does not reach. Those used to have no preview entry at
    // all: `sync()` derived over the window, `derive()` keeps only the clips
    // inside it, the node was not found, its shot was dropped as gone, and
    // `shotView` drew nothing — not a failure, not a wait, no reason. Three
    // clips end to end left two thirds of the graph blank with every line of the
    // code that built it looking correct.
    //
    // The claim is not that every node has a picture: `amix` genuinely is not in
    // the graph at an instant where fewer than two clips are playing, and saying
    // so is the right answer. The claim is that **nothing on the screen is
    // silently empty**.
    {
        console.log('\na graph longer than the window it is previewed over');
        overlay.clear();
        dropFiles(400, 300, [media]);
        waitFor('a second clip', () => A.project.clips.length === 2);
        pump(200);

        // End to end, and the previews taken from inside the second one — so
        // every node of the first is outside the window.
        const cs = A.project.clips;
        cs[0].track = 0; cs[0].start = 0;
        cs[1].track = 0; cs[1].start = cs[0].length;
        const inSecond = cs[1].start + 1;
        A.graph.preview.setRange(inSecond, inSecond + A.graph.preview.previewSeconds);
        A.graph.draw();
        pump(600);

        const boxes = A.graph.placement().nodes || [];
        ok(boxes.length > 8, `the whole edit is drawn — ${boxes.length} cards`);
        const firstClip = boxes.filter((b) => keyOfBox(b).indexOf(`clip:${cs[0].id}`) >= 0);
        ok(firstClip.length > 0, 'including the cards of the clip the window misses');

        const silent = boxes.filter((b) => !A.graph.preview.shotFor(keyOfBox(b)));
        if (silent.length)
            console.log('    silent: ' + silent.map((b) => keyOfBox(b)).join(', '));
        same(silent.length, 0, 'and not one card on the screen is left with nothing to say');

        // The clip the window misses is answered *about its own seconds*, which
        // is the whole of the fix: a window inside that clip rather than the one
        // somebody chose somewhere else.
        const far = A.graph.preview.shotFor(keyOfBox(firstClip[0]));
        ok(!!far && far.from < cs[1].start,
           `a clip outside the window is looked at inside itself (from ${far && far.from})`);

        // ── a waveform is not an animation ─────────────────────────────────
        //
        // `showwaves` draws the sound a column at a time, so the last frame of
        // one of these renders is the whole waveform and every frame before it
        // is a partial — which is why the audio tail ends in a `tpad` that
        // clones that last frame. Looped, the finished picture is wiped back to
        // nothing twice a second on every sound card at once, and the `tpad` is
        // paid for and thrown away. A picture card still loops: two seconds of
        // motion is what it is for.
        {
            const waveVideo = () => document.querySelector('#gr-nodes .gn-wave video');
            const picVideo = () => {
                for (const s of document.querySelectorAll('#gr-nodes .gn-shot')) {
                    if ((s.getAttribute('class') || '').indexOf('gn-wave') >= 0) continue;
                    const v = s.querySelector('video');
                    if (v) return v;
                }
                return null;
            };
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline && !(waveVideo() && picVideo())) pump(250);

            const w = waveVideo(), p = picVideo();
            if (!w) {
                // Said out loud rather than passing quietly: a check that
                // skipped for want of a render would look like a check.
                console.log('  SKIP  whether a waveform loops — no sound card was ready in time');
            } else {
                ok(w.loop === false, 'a waveform card runs once and settles on the finished picture');
                if (p) ok(p.loop === true, 'and a picture card still loops its couple of seconds');
                else console.log('  SKIP  whether a picture card loops — none was ready in time');
            }
        }

        A.removeSelection && A.select(cs[1]);
        A.removeSelection && A.removeSelection();
        overlay.clear();
        A.graph.draw();
        pump(160);
    }
}

console.log(`\nPASS ui_graph — ${checks} checks`);
