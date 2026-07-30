// What is wrong with this graph, said in sentences that name the node.
//
// While the only graph on the screen was the one the derivation built, this
// file had nothing to do: a derivation produces one shape, every pad it makes
// is wired the moment it is made, and the printer was written against exactly
// that. A graph anybody can wire produces shapes nobody wrote the printer for —
// a pad feeding two filters, a node with an empty input, a `split` whose second
// output goes nowhere, two nodes feeding each other in a circle.
//
// And, since a person can place an output of their own, everything a *name*
// has to be for a stream to be fed from it: present, spelt the way a
// filtergraph spells a pad label, not one of the two the derivation reserves,
// and not shared with another output.
//
// **The rule is refusal, not approximation.** It is the same rule the
// derivation already follows and it is the whole value of printing a command:
// a filtergraph is worth showing because it can be copied somewhere else and
// run, and one that ffmpeg would reject is worse than no graph at all, because
// it looks like one. So every shape below is something ffmpeg itself refuses,
// and each answer names the node and says what to do about it.
//
// They are checked here rather than in `print.js` because printing and running
// are not the only things that ask. `subgraph.js` prints a *pruned* view where
// half the outputs deliberately go nowhere — that is what cutting a graph off
// at a node means — so a printer that refused would refuse every preview. The
// full graph is the only thing these questions are meaningful about.

import { streamsOf, keyOf, streamWord, padTakes } from './model.js';
import { padsOf } from './filters.js';
import { supportsTimeline } from './enable.js';
import { deviceOfFilter, isCrossing, present } from '../hardware.js';

/// What to call a node in a sentence. A filter is its own name; the two ends
/// are named the way their cards are, because that is what the person is
/// looking at.
export function nameOf(n) {
    if (!n) return 'a node';
    // An input the graph reads on its own account carries the name of the input
    // it is, because "input 3" is a number in a list nobody has in front of them
    // and "logo.png" is the thing they placed.
    if (n.kind === 'input') return n.title ? `${n.title} (input ${n.index})` : `input ${n.index}`;
    // A pad somebody named is called by its name, because that is what they
    // will read on the Write stage and in the printed command. Only the
    // derivation's own two are "the render".
    if (n.kind === 'sink')
        return isUserOutput(n) ? (n.name ? `output [${n.name}]` : 'an unnamed output')
             : n.stream === 'a' ? 'audio out' : 'video out';
    return n.filter || 'a filter';
}

/// A sink a person placed, as against the derivation's own two.
///
/// Told apart by carrying a `name` at all — an empty one is an output somebody
/// cleared the name of, which is a graph with a problem in it and not one of the
/// render's own ends. Every hand-built sink in the tests predates the field and
/// answers no, which is what keeps them reading as `video out`.
export function isUserOutput(n) {
    return !!n && n.kind === 'sink' && n.name !== undefined;
}

const ordinal = (i, of) => (of > 1 ? `input ${i + 1} of ${of}` : 'input');

/// Every problem in `g`, in node order. Empty means it prints and runs.
///
/// `stranded` is what the overlay could not put back — a wire whose pad the node
/// no longer has, because the option that decides its pad count was changed
/// under it. Passed in rather than found here: only the thing that applied the
/// overlay knows what it could not apply, and a wire that is not in the graph
/// cannot be discovered from the graph.
export function problems(g, stranded = []) {
    const out = [];
    const say = (node, reason) => out.push({ key: keyOf(node), id: node ? node.id : null,
                                             node, reason });
    const streams = streamsOf(g);

    for (const n of g.nodes) {
        // A filter this build does not have is not a shape at all — there is no
        // pad list to check and no chain that could run. Said first because
        // every other complaint about such a node would be noise.
        if (n.kind === 'filter' && !padsOf(n.filter, n.params, n.pos)) {
            say(n, `libavfilter in this build has no filter called “${n.filter}”`);
            continue;
        }

        // **`enable` on a filter that has no timeline support is refused by
        // libavfilter, not ignored.** `set_enable_expr` checks
        // AVFILTER_FLAG_SUPPORT_TIMELINE and returns AVERROR_PATCHWELCOME, so a
        // graph carrying one fails as it is built and the render produces
        // nothing. The panel does not offer a strip for such a filter; this is
        // for the value arriving the other way — typed into the raw field, or
        // moved onto a filter it does not suit — where the alternative is a
        // render that stops with libavfilter's own wording and no node named.
        if (n.kind === 'filter' && n.params.enable !== undefined &&
            String(n.params.enable) !== '' && !supportsTimeline(n.filter))
            say(n, `${nameOf(n)} has no timeline support in this build, so enable= on it ` +
                   'is refused when the graph is built — libavfilter will not run it');

        const ins = g.inPorts(n);
        const arriving = g.inEdges(n);
        for (let p = 0; p < ins; p++) {
            const at = arriving.filter((e) => (e.port || 0) === p);
            if (!at.length) {
                const why = n.kind === 'sink'
                    ? emptySink(g, n)
                    : `${nameOf(n)} has nothing wired to its ${ordinal(p, ins)}`;
                if (why) say(n, why);
            }
            // Two wires into one pad is not a mix, it is a graph with no answer
            // to which one arrives — and nothing in this application can make
            // one, so it is here for a hand-edited overlay rather than for a
            // gesture.
            else if (at.length > 1)
                say(n, `two wires arrive at ${nameOf(n)}’s ${ordinal(p, ins)}`);
            // The stream check is the one that catches a wire nobody would draw
            // on purpose and everybody draws once: a picture dropped on
            // `amix`, a sound dropped on `overlay`. libavfilter's own message
            // for it names a pad index and no filter.
            else if (n.ins && n.ins[p]) {
                const carried = streams.ofEdge(at[0]);
                const wanted = n.ins[p].stream;
                if (carried && wanted && !padTakes(carried, wanted))
                    say(n, `a ${streamWord(carried)} wire arrives at ` +
                           `${nameOf(n)}’s ${ordinal(p, ins)}, which takes ` +
                           `${wanted === 'a' ? 'sound' : wanted === 's' ? 'cues'
                                                                        : 'a picture'}`);
            }
        }

        const outs = g.outPorts(n);
        const leaving = g.outEdges(n);
        for (let p = 0; p < outs; p++) {
            const at = leaving.filter((e) => (e.fromPort || 0) === p);
            const pad = outs > 1 ? `output ${p + 1} of ${outs}` : 'output';
            // ffmpeg's parser will not run a graph with a pad hanging off it,
            // and this is also the state a node sits in for the moment between
            // being placed and being wired — so it has to read as "not finished
            // yet" rather than as an accusation.
            if (!at.length) {
                // **An input's pads are ffmpeg's, not a filter's.** `[1:v]` and
                // `[1:a]` are labels on a demuxer's streams, and a label nothing
                // references is ordinary: a logo opened for its picture does not
                // have to have its sound consumed by something. So an unread pad
                // on an input is only worth a word when *none* of them is read —
                // the file would then be opened and thrown away, which is also
                // the state a source sits in between being placed and being
                // wired.
                if (n.kind !== 'input') say(n, `nothing reads ${nameOf(n)}’s ${pad}`);
                else if (!leaving.length && p === 0)
                    say(n, `nothing reads ${nameOf(n)} — wire one of its pads, ` +
                           'or it is opened for nothing');
            }
            // **The one people are surprised by.** A pad can be read once.
            // Reading it twice is what `split` is for, and ffmpeg says "Label
            // found twice" about a graph it has already half-parsed.
            else if (at.length > 1)
                say(n, `${nameOf(n)}’s ${pad} is read by ${at.length} filters — ` +
                       `a pad can only be read once, so put ` +
                       `${streams.of(n) === 'a' ? 'an asplit' : 'a split'} in between`);
        }
    }

    outputProblems(g, say);

    for (const p of memoryProblems(g, streams)) out.push(p);

    for (const s of stranded) {
        const node = s.node;
        const has = node ? g.inPorts(node) : 0;
        say(node, `${nameOf(node)} has ${has} input${has === 1 ? '' : 's'}, so your wire ` +
                  `at input ${s.port + 1} has nowhere to land — raise its input count to ` +
                  `keep it, or delete the wire`);
    }

    for (const cycle of cycles(g))
        say(cycle[0], `these feed each other in a circle: ${cycle.map(nameOf).join(' → ')} → ` +
                      `${nameOf(cycle[0])}`);

    return out;
}

/// A sink with nothing arriving at it, and the one case where that is not a
/// complaint. Answers null for "nothing to say".
///
/// The derivation's sink *is* the render: nothing wired to it means nothing to
/// write, and that is the sentence it has always had. Unless the picture leaves
/// by a name instead — a stream fed from `pad:<label>` reads an output somebody
/// placed, and a graph whose whole picture goes out that way has no use for the
/// derivation's own pad. Native draws the same line: a graph with no `vout` is
/// refused only where a stream actually asks for the composite.
function emptySink(g, n) {
    if (isUserOutput(n))
        return `nothing is wired into ${nameOf(n)}, so no stream can be fed from it`;
    const carried = g.nodes.some((x) => isUserOutput(x) && x.name &&
                                        (x.stream || 'v') === (n.stream || 'v') &&
                                        g.inEdges(x).length);
    if (carried) return null;
    return `nothing is wired to ${nameOf(n)}, so the render has no ${
        n.stream === 'a' ? 'sound' : 'picture'} to write`;
}

/// What a named output has to be for a stream to be fed from it.
///
/// **The name is the identity**, so all of this is about the name. It becomes a
/// pad label in a `-filter_complex` and a `pad:<label>` on the Write stage, and
/// every rule below is a shape ffmpeg itself refuses — which is the entry
/// requirement for everything in this file. The renderer refuses each of them
/// too, before it opens a file, and says so in almost these words; said here
/// because that is where the decision was taken.
function outputProblems(g, say) {
    const seen = new Map();
    for (const n of g.nodes) {
        if (!isUserOutput(n)) continue;
        const name = String(n.name || '');
        if (!name) {
            say(n, 'this output has no name, so nothing can be mapped to it — a stream is ' +
                   'fed from a pad by writing its label down, and there is nothing to write');
            continue;
        }
        if (!/^[A-Za-z0-9_]+$/.test(name)) {
            say(n, `“${name}” is not a pad label — a filtergraph names one with letters, ` +
                   'digits and underscores, and reads anything else as the end of the name');
            continue;
        }
        // `vout` and `aout` are what the derivation calls the composite and the
        // mix, and the renderer decides which pad is which by exactly those two
        // words when a graph ends in several. A second [vout] is not a clash of
        // spellings, it is two answers to "which of these is the picture".
        if (name === 'vout' || name === 'aout') {
            say(n, `[${name}] is the derivation’s own name for the ${
                name === 'vout' ? 'composite' : 'mix'}, so an output called that leaves ` +
                'nothing to say which pad the render’s own picture and sound come out of ' +
                '— call it something else');
            continue;
        }
        if (seen.has(name))
            say(n, `two outputs are called [${name}] — a pad is produced once, and ffmpeg ` +
                   'refuses a graph where a label is used twice');
        else seen.set(name, n);

        // **An `-i`'s pad cannot be renamed.** `[1:v]` is a demuxer's stream and
        // there is no chain to put a label on the end of, so the graph would
        // print and run and the render would then be refused for a pad that is
        // not there. One filter in between is all it takes.
        const e = g.inEdges(n)[0];
        const src = e ? g.node(e.from) : null;
        if (src && src.kind === 'input')
            say(n, `${nameOf(n)} is fed straight from ${nameOf(src)}, and an -i’s pad cannot ` +
                   'be given a name of its own — put a filter between them (null, or format) ' +
                   'so that there is a chain to label');
    }
}

/// **`trim`, `setpts` and their kind want neither memory nor a card**, and that
/// is not a special case bolted on — a filter with no pixel format constraints
/// passes whatever it is given, which is exactly why a render can keep its
/// picture on the card through a build that has no `scale_cuda` in it. They are
/// told apart by having no formats of their own to negotiate, which is a fact
/// this side cannot ask libavfilter for; so the rule below is the conservative
/// one, and only a filter that *belongs to a device* or is known to read pixels
/// is judged. A filter nobody has an opinion about is left alone, because a
/// false accusation on a graph that runs is worse than a missing note on one
/// that does not.
const PASSES_ANYTHING = new Set(['trim', 'setpts', 'settb', 'fps', 'select',
                                 'null', 'copy', 'metadata', 'realtime']);

/// The one fact, resolved over a whole graph: for each node, is the picture it
/// produces on a device or in system memory.
///
/// **Resolved by asking upstream, not by walking the array in order.** A node's
/// producers are earlier in `g.nodes` for a graph the derivation built and are
/// *not* for one somebody edited: `insertAfter` appends, so a filter spliced
/// onto the first wire sits at the end of the list. Reading the array in order
/// therefore had every node after an insertion answering "in system memory"
/// because the thing feeding it had not been reached yet, which is a wrong
/// answer that looks exactly like a right one.
///
/// Returned as a resolver rather than a map because it is asked lazily and it
/// memoises: two callers over one graph pay for one walk.
function memoryMap(g) {
    const where = new Map();      // node id → 'device' | 'memory'
    const busy = new Set();
    const carried = streamsOf(g);

    const at = (n) => {
        if (!n) return 'memory';
        if (where.has(n.id)) return where.get(n.id);
        if (busy.has(n.id)) return 'memory';      // a cycle; `cycles()` names it
        busy.add(n.id);
        const answer = resolve(n);
        busy.delete(n.id);
        where.set(n.id, answer);
        return answer;
    };

    /// Where every picture arriving at `n` is. **A list, not one answer**: an
    /// `overlay` has two inputs and they are not interchangeable — the canvas
    /// comes from a `color` source in system memory and the clip comes from a
    /// chain that may have put itself on a card. Reading only the first said
    /// "system memory" about a node whose second input was a CUDA surface,
    /// which is the exact graph this check exists for.
    const arrivingAll = (n) => {
        const seen = [];
        for (const e of g.inEdges(n)) {
            const from = g.node(e.from);
            if (!from) continue;
            // **A pad of cues is in system memory whatever the input decodes
            // on.** `-hwaccel_output_format` is a decision about the *decoder*,
            // and there is no hardware subtitle decode: this renderer paints the
            // bitmaps into frames itself. Read off the node instead, an overlay
            // drawing a DVD's cues over a clip from the same `-hwaccel` input
            // would be reported as being handed a picture on a card — a
            // confident accusation about the one wire this feature exists for.
            seen.push(carried.ofEdge(e) === 's' ? 'memory' : at(from));
        }
        return seen;
    };
    const arrivingAt = (n) => arrivingAll(n)[0] || 'memory';

    function resolve(n) {
        // **Read off the node, not out of the document.** The derivation writes
        // it there (`inputOnDevice` in derive.js) from the same `spec.inputs`
        // the renderer is handed, so the graph and the render cannot disagree
        // about where a picture starts out. This used to index the live
        // `inputs` array from `ui/inputs.js`, which made a graph's answer
        // depend on module state the graph was not derived from — and asked the
        // question with one term missing, so an input carrying an output format
        // with no `-hwaccel` in front of it answered "on a card" here and "in
        // system memory" three hundred lines away.
        if (n.kind === 'input') return n.onDevice ? 'device' : 'memory';
        // A sink produces nothing; what matters about it is what arrives.
        if (n.kind === 'sink') return arrivingAt(n);
        const filter = n.filter || '';
        if (filter === 'hwupload' || /^hwupload_/.test(filter)) return 'device';
        if (filter === 'hwdownload') return 'memory';
        if (PASSES_ANYTHING.has(filter)) return arrivingAt(n);
        return deviceOfFilter(filter) ? 'device' : 'memory';
    }

    return { at, arrivingAll };
}

/// Where the picture leaving `node` is: `'device'` or `'memory'`.
///
/// Exported because this one fact answers three different questions in three
/// places, and only the questions differ. `memoryProblems` below asks whether
/// every node's expectation holds; `graph/subgraph.js` asks whether one pad's
/// picture is on a card, so that a preview's tail knows to put an `hwdownload`
/// in; and `export/warnings.js` asks whether the picture the *encoder* is
/// handed ends up on one, which is the difference between a render the writer
/// refuses and a render that copies every frame down behind your back.
///
/// It used to be answered in `warnings.js` by looking for `hwupload` in the
/// last chain of the printed graph, which is not the same question and was not
/// even the same *chain*: `print()` walks `g.nodes` in order and `derive()`
/// builds the audio runs after the video sink, so the last chain of any render
/// with sound in it is an `atrim`. The warning was therefore off whenever
/// there was a soundtrack, and flipped when Include audio was toggled.
export function whereIs(g, node) {
    if (!g || !node) return 'memory';
    return memoryMap(g).at(node);
}

/// Where the picture is, and who can read it there.
///
/// **libavfilter's own message for getting this wrong is four hundred pixel
/// format names and no filter.** A `cuda` frame arriving at `scale` produces
/// "Impossible to convert between the formats supported by the filter
/// 'Parsed_setpts_1' and the filter 'auto_scale_0'", followed by every format
/// swscale has ever heard of, and nothing in it says the word hardware. It is
/// the single least readable failure in this application, and it is one
/// sentence to explain: a picture on a card is a handle, not pixels, and a
/// filter that reads pixels cannot have it.
///
/// So this carries the one fact above — is the picture up or down — and names
/// the first node where the two disagree. Three things move it: a source that
/// decodes on a device starts it up, `hwupload` puts it up and `hwdownload`
/// brings it down. A filter belonging to a device wants it up; everything else
/// wants it down.
function memoryProblems(g, streams) {
    const out = [];
    // Nothing to say on a machine with no device: every picture is in system
    // memory and every filter can read it.
    if (!present().length) return out;

    const passesAnything = PASSES_ANYTHING;
    const { arrivingAll } = memoryMap(g);

    for (const n of g.nodes) {
        if (n.kind === 'input' || n.kind === 'sink') continue;
        // **Sound is never on a card.** An input that decodes its pictures on
        // one still decodes its soundtrack with libavcodec — there is no
        // hardware AAC decoder and asking for one would refuse every file with
        // a track in it — so the whole of this walk is about the picture. Left
        // out, an `atrim` hanging off the same `-i` was reported as a filter
        // that could not read what was reaching it, which is the sort of
        // confident nonsense a checker exists to avoid.
        if (streams.of(n) === 'a') continue;

        const filter = n.filter || '';
        const arriving = arrivingAll(n);
        if (filter === 'hwdownload') {
            if (!arriving.some((a) => a === 'device'))
                out.push({ key: keyOf(n), id: n.id, node: n,
                           reason: `${nameOf(n)} brings a picture down off a card and the ` +
                                   'picture reaching it is already in system memory — ' +
                                   'libavfilter refuses that outright' });
            continue;
        }
        if (isCrossing(filter) || passesAnything.has(filter)) continue;

        const wants = deviceOfFilter(filter) ? 'device' : 'memory';
        // Every input, because a filter with two of them is refused for the one
        // that disagrees and says nothing about which.
        const wrong = arriving.find((a) => a !== wants);
        if (wrong)
            out.push({ key: keyOf(n), id: n.id, node: n,
                       reason: wrong === 'device'
                           ? `the picture reaching ${nameOf(n)} is on a card, and ${filter} ` +
                             'reads pixels — put an hwdownload in front of it, or a filter ' +
                             'from the card’s own family'
                           : `${filter} works on pictures that are already on a card, and ` +
                             `the one reaching ${nameOf(n)} is in system memory — put an ` +
                             'hwupload in front of it' });
    }
    return out;
}

/// The loops, one node list each.
///
/// A depth-first walk with a colouring, which is the standard one and is worth
/// spelling out here rather than relying on the fixed-point relaxations
/// elsewhere: `depths()` and `streamsOf()` both survive a cycle by giving up
/// after a bounded number of passes, which draws *something* and never says
/// what. A cycle has to be named, because it is the one shape where every other
/// complaint the checker makes is a consequence rather than the cause.
function cycles(g) {
    const state = new Map();          // 0 unvisited, 1 on the stack, 2 done
    const found = [];
    const stack = [];

    const walk = (n) => {
        state.set(n.id, 1);
        stack.push(n);
        for (const e of g.outEdges(n)) {
            const next = g.node(e.to);
            if (!next) continue;
            const s = state.get(next.id) || 0;
            if (s === 1) {
                const at = stack.findIndex((x) => x.id === next.id);
                if (at >= 0) found.push(stack.slice(at));
            } else if (s === 0) walk(next);
        }
        stack.pop();
        state.set(n.id, 2);
    };

    for (const n of g.nodes) if (!state.get(n.id)) walk(n);
    return found;
}
