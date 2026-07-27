// The inputs: what will be opened, how, and what came back.
//
// This stage was a read-only list derived from the timeline — distinct paths,
// one card each, straight out of `probe()`. That is a description of an NLE's
// idea of a source, and it is the wrong end of ffmpeg: an input is an `-i`, it
// carries a demuxer and an option bag and a window, and it exists whether or
// not anything is cut from it. So the stage is where inputs are *added,
// configured and understood*.
//
// Three columns, in the order the questions are asked. Which inputs there are,
// what this one is set to and what it turned out to contain, and — beside it —
// the demuxer's own option table, drawn by the component the encoder's and the
// muxer's columns use (see ui/opttable.js).
//
// Two things it is careful about, both of them the point of the stage:
//
//   - **An input seek is not a clip's in-point**, and the panel says so where
//     the two are next to each other. `-ss` decides what the input *is*: its
//     zero moves, its duration shrinks, and the clips cut from it are measured
//     from there. Trimming a clip picks a moment out of an input.
//   - **The probe is the answer to what the options just did.** It is re-run
//     with the options in force, so the stream list under them is the file as
//     this input opens it and not as libavformat's defaults see it.

import { div, span, el, put, row, head, fromTemplate, show, segmented,
         select } from './dom.js';
import { devicesFor, deviceNamed, decodeCost } from './hardware.js';
import { clock, bytes, kbps } from './format.js';
import { inputs, addInput, updateInput, reprobe, removeInput, summary, schemeOf,
         lengthOf, kindOf, endless } from './inputs.js';
import { typedSpec, concatSpec, SEQUENCE_FPS } from './sequence.js';
import { optionColumn } from './opttable.js';
import * as graph from './graph/overlay.js';
import { streamsOf } from './export/streams.js';
import { readsInput, filterPath } from './export/subtitles.js';
import { goTo } from './shell.js';

let refs = {};
let hooks = {};

// Which input the detail column is about, by id. By id and not by reference
// because the list is rebuilt from the model on every change, and an input that
// has gone should leave the panel showing the next one rather than a card that
// is no longer in the document.
let chosenId = '';

// The demuxer picker is a search over three hundred and fifty names, not a
// dropdown: there is no list of the good ones anywhere, which is the same
// problem the muxer picker and the filter palette have and the same shape of
// answer.
let demuxerOpen = false;
let demuxerSearch = '';

export function initSources(nodes, h) {
    refs = nodes || {};
    hooks = h || {};

    if (refs.add && refs.addPath) {
        const add = () => {
            const path = refs.addPath.value.trim();
            if (!path) return;
            // Typing `shot_%04d.png` means a sequence in exactly the way
            // dropping the folder does, and a path that is one picture means a
            // still. Anything else is a file or a URL and nothing is added to
            // it — see ui/sequence.js.
            const input = addInput(typedSpec(path));
            refs.addPath.value = '';
            chosenId = input.id;
            if (input.error && hooks.flash) hooks.flash(input.error);
            if (hooks.changed) hooks.changed();
            drawSources();
        };
        refs.add.addEventListener('click', add);
        // Enter in the field is the same act. A path typed and then abandoned
        // because the button was somewhere else is the commonest way a field
        // like this fails.
        refs.addPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    }

    if (refs.join) refs.join.addEventListener('click', () => {
        joinOpen = !joinOpen;
        drawSources();
    });
}

// Which inputs the join is about, by id. Held here rather than on the inputs
// because it is a gesture in progress and not part of the document — the same
// reason the demuxer picker's search term is not in the model.
let joinOpen = false;
const joining = new Set();

/// The input the panel is about: the one chosen, or the first one there is.
function chosen() {
    return inputs.find((i) => i.id === chosenId) || inputs[0] || null;
}

export function drawSources() {
    if (!refs.list) return;
    drawList();
    drawDetail();
}

// ── the list ───────────────────────────────────────────────────────────────

/// Which inputs the graph reads on its own account, by id.
///
/// **An input with no clip is not necessarily unused.** A logo laid over the
/// picture is an `-i` that nothing on the timeline is cut from, and a card
/// reading "unused" beside a file the render is about to open would be the one
/// thing this stage cannot afford to get wrong.
function graphReads() {
    return new Set(graph.sourceInputs());
}

/// Which inputs a stream row on the Write stage reads, by `-i` number.
///
/// The other way an input is used without a clip being cut from it. A subtitle
/// file is the case that makes it necessary — nothing on the timeline is ever
/// cut from one — but a copied soundtrack is the same shape and was already
/// being reported as unused.
function streamReads() {
    const out = new Set();
    for (const s of streamsOf()) {
        const at = readsInput(s);
        if (at) out.add(at.input);
    }
    return out;
}

function drawList() {
    const current = chosen();
    const reads = graphReads();
    const subtitleWriters = streamReads();
    put(refs.list, () => {
        if (!inputs.length)
            return [
                div('dim pad', 'No inputs. Add a path or a URL above, or drop a file ' +
                               'on the timeline.'),
                ...graphFileRows(),
            ];
        if (joinOpen) return joinRows();
        return [...inputs.map((input) => {
            const node = fromTemplate('tpl-input');
            const used = hooks.clipsOf ? hooks.clipsOf(input).length : 0;
            const inGraph = reads.has(input.id);
            node.classList.toggle('on', input === current);
            node.classList.toggle('bad', !!input.error);
            node.setAttribute('data-input', input.id);
            node.querySelector('.src-n').textContent = `${inputs.indexOf(input)}`;
            node.querySelector('.src-name').textContent = input.name;
            node.querySelector('.src-where').textContent = input.path;
            // What is *set* on it, in ffmpeg's own words. An input carrying
            // nothing says nothing rather than saying "default", which would be
            // a row of noise on every card in the ordinary case.
            node.querySelector('.src-set').textContent = summary(input);
            // A file of cues is never cut into a clip and is used all the same
            // — by a stream row on the Write stage, or by a `subtitles=` node
            // burning it into the picture. Both are counted, because "unused"
            // beside a file the render is about to open is the one thing this
            // stage cannot afford to get wrong, and a subtitle file would
            // otherwise read that way permanently.
            const written = subtitleWriters.has(inputs.indexOf(input));
            node.querySelector('.src-used').textContent =
                input.error ? 'unreadable'
                : [used ? `${used} clip${used === 1 ? '' : 's'}` : '',
                   written ? 'written into the output' : '',
                   inGraph ? 'read by the graph' : ''].filter(Boolean).join(' · ') || 'unused';
            node.addEventListener('click', () => {
                chosenId = input.id;
                demuxerOpen = false;
                drawSources();
            });
            return node;
        }), ...graphFileRows()];
    });
}

/// A `movie` filter's filename, with the filtergraph escaping taken off.
///
/// `movie=C\:/logo.png` and `movie=C\://logo.png` are how a Windows path has to
/// be written inside a filter argument, because a colon separates arguments.
/// What is wanted here is the path.
function unescapePath(text) {
    return String(text || '').replace(/\\(.)/g, '$1');
}

/// Files the graph opens for itself, which are the one way this stage can stop
/// being every file the render opens.
///
/// A `movie` filter is not an `-i`: it opens the file inside libavfilter, with
/// none of the demuxer options, none of the window and none of the probing that
/// the rows above are made of. The application does not reach for it — a source
/// placed on the Graph stage is an input reference, for the reasons written in
/// `graph/derive.js` — but it is an ordinary filter and the palette offers every
/// one of those, so what it names is accounted for here rather than left off the
/// list and quietly opened.
function graphFileRows() {
    const nodes = graph.nodes().filter((n) => n.filter === 'movie' || n.filter === 'amovie');
    if (!nodes.length) return [];
    return [
        head('Opened by the graph'),
        div('src-join-note dim',
            'A movie filter opens its file inside libavfilter, so nothing above reaches it: ' +
            'no forced demuxer, no -probesize, no window, no probe. Added as an input it ' +
            'gets all of them, and the graph can read it as [n:v] instead.'),
        ...nodes.map((n) => {
            const named = (n.params && n.params.filename) || (n.pos && n.pos[0]) || '';
            const path = unescapePath(named);
            return div('src-demux', [
                span(n.filter, 'mono'),
                span(path || 'no file named yet', path ? 'dim' : 'src-missing'),
                path ? el('button', {
                    cls: 'tiny', 'data-f': 'srcadopt', text: 'Add as an input',
                    title: 'Open it as an -i, with a demuxer, options and a window',
                    on: { click: () => {
                        const made = addInput(typedSpec(path));
                        chosenId = made.id;
                        if (made.error && hooks.flash) hooks.flash(made.error);
                        if (hooks.changed) hooks.changed();
                        drawSources();
                    } },
                }) : null,
            ]);
        }),
    ];
}

/// Several files as one `-i`, in the order they are ticked.
///
/// **This is the concat *demuxer*, and saying so is the point of the panel.**
/// It reads the listed files one after another before anything is decoded, so
/// they have to be encoded compatibly; the concat *filter* joins decoded
/// streams inside the graph and does not care; and two clips laid end to end
/// on the timeline is neither, because that is an edit and goes through the
/// compositor. All three are reachable from this application, and somebody
/// reaching for "join these two files" can mean any of them.
function joinRows() {
    const candidates = inputs.filter((i) => kindOf(i) !== 'concat' && i.probe);
    const chosenPaths = () =>
        candidates.filter((i) => joining.has(i.id)).map((i) => i.path);

    const rows = [
        div('src-join-note dim',
            'The concat demuxer reads these files one after another as a single -i, before ' +
            'anything is decoded — so they have to be encoded compatibly. To join clips ' +
            'that are not, lay them end to end on the timeline instead; that is an edit ' +
            'and goes through the compositor.'),
        ...candidates.map((input) => el('button', {
            cls: 'src-demuxer tiny' + (joining.has(input.id) ? ' on' : ''),
            'data-join': input.id,
            on: { click: () => {
                if (joining.has(input.id)) joining.delete(input.id);
                else joining.add(input.id);
                drawSources();
            } },
        }, [
            span(joining.has(input.id) ? '✓' : '·', 'mono'),
            span(input.name),
            span(clock(lengthOf(input)), 'dim mono'),
        ])),
    ];

    if (!candidates.length)
        rows.push(div('dim pad', 'Nothing to join yet — add two files above.'));

    rows.push(div('src-actions', [
        el('button', {
            cls: 'tiny primary', 'data-f': 'srcjoingo', text: 'Join as one -i',
            disabled: chosenPaths().length < 2,
            on: { click: () => {
                const made = addInput(concatSpec(chosenPaths()));
                joining.clear();
                joinOpen = false;
                chosenId = made.id;
                if (made.error && hooks.flash) hooks.flash(made.error);
                if (hooks.changed) hooks.changed();
                drawSources();
            } },
        }),
        el('button', {
            cls: 'tiny', 'data-f': 'srcjoincancel', text: 'Cancel',
            on: { click: () => { joining.clear(); joinOpen = false; drawSources(); } },
        }),
    ]));
    return rows;
}

// ── the input ──────────────────────────────────────────────────────────────

function drawDetail() {
    const input = chosen();
    show(refs.options, !!input);
    if (!input) {
        put(refs.detail, () => div('dim pad',
            'Nothing selected. An input is one `-i`: a file or a URL, a demuxer, ' +
            'its options and the part of it you want.'));
        put(refs.options, () => []);
        return;
    }

    put(refs.detail, () => [
        head(input.name),
        ...whereRows(input),
        ...demuxerRows(input),
        ...assemblyRows(input),
        ...decodeRows(input),
        ...windowRows(input),
        ...actionRows(input),
        ...contentRows(input),
    ]);

    // The demuxer's own option table, beside the input rather than under it,
    // for the reason the encoder's and the muxer's are: mp4's demuxer has
    // thirty options and libavformat's generic table another forty, and a fold
    // is not somewhere anybody reads seventy rows.
    put(refs.options, () => optionRows(input));
}

/// Where it comes from, and what is answering for that.
function whereRows(input) {
    const path = el('input', {
        cls: 'wide', 'data-f': 'srcpath', type: 'text', value: input.path,
        on: { change: () => change(input, { path: path.value.trim() }) },
    });
    const rows = [row('Path or URL', path)];

    const scheme = schemeOf(input.path);
    const protocols = (bro.ffmpeg.protocols && bro.ffmpeg.protocols.input) || [];
    if (scheme) {
        // A URL naming a protocol this build does not have fails at open with a
        // message about a filename, which is the least helpful place to find
        // out. Every protocol here is one `avio_enum_protocols` reported.
        const known = protocols.indexOf(scheme) >= 0;
        rows.push(row('Protocol', span(
            known ? `${scheme} · linked in` : `${scheme} · not in this build`,
            known ? 'mono' : 'mono src-missing')));
    } else if (input.path) {
        rows.push(row('Protocol', span('file', 'mono dim')));
    }
    return rows;
}

/// What it probed as, and what it can be forced to.
function demuxerRows(input) {
    const probed = input.probe ? input.probe.format.name : '';
    const rows = [row('Demuxer', div('src-demux', [
        span(input.format ? `-f ${input.format}` : (probed || 'not read yet'),
             input.format ? 'mono' : 'mono dim'),
        el('button', {
            cls: 'tiny', 'data-f': 'demuxpick',
            text: demuxerOpen ? 'Close' : 'Force…',
            on: { click: () => { demuxerOpen = !demuxerOpen; drawSources(); } },
        }),
        input.format && el('button', {
            cls: 'tiny', 'data-f': 'demuxprobe', text: 'Probe it',
            on: { click: () => change(input, { format: '' }) },
        }),
    ]))];

    if (!input.format && probed)
        rows.push(row('', span('probed — libavformat worked it out from the file', 'dim')));

    if (demuxerOpen) rows.push(demuxerPicker(input));
    return rows;
}

/// Three hundred and fifty demuxers, searched rather than listed.
///
/// The same shape as the muxer picker one stage along, and for the same reason:
/// nothing here is a list of the good ones, and a name is what `-f` takes.
function demuxerPicker(input) {
    const list = div('src-picker');
    const draw = () => put(list, () => {
        const term = demuxerSearch.trim().toLowerCase();
        const all = bro.ffmpeg.demuxers || [];
        const matching = term
            ? all.filter((d) => d.name.toLowerCase().indexOf(term) >= 0 ||
                                (d.longName || '').toLowerCase().indexOf(term) >= 0 ||
                                (d.extensions || []).some((e) => e.indexOf(term) >= 0))
            : all;
        const shown = matching.slice(0, 24);
        const out = shown.map((d) => el('button', {
            cls: 'src-demuxer tiny' + (d.name === input.format ? ' on' : ''),
            'data-demuxer': d.name,
            on: { click: () => { demuxerOpen = false; change(input, { format: d.name }); } },
        }, [
            span(d.name, 'mono'),
            span(d.longName || '', 'dim'),
            d.extensions && d.extensions.length ? span(d.extensions.join(' '), 'dim mono') : null,
        ]));
        if (matching.length > shown.length)
            out.push(div('ex-note dim',
                         `and ${matching.length - shown.length} more — narrow the search`));
        return out;
    });

    const search = el('input', {
        cls: 'wide', 'data-f': 'demuxsearch', type: 'text', value: demuxerSearch,
        placeholder: `name, description or extension — ${(bro.ffmpeg.demuxers || []).length} of them`,
        on: { input: () => { demuxerSearch = search.value; draw(); } },
    });
    draw();
    return div('src-pick', [row('Find', search), list]);
}

// ── inputs whose content is assembled ──────────────────────────────────────
//
// A numbered run of files, a single picture held for a chosen length, and a
// list read end to end are three inputs that are not a file. **Everything they
// are set with is an ordinary demuxer option** — `-framerate`,
// `-start_number`, `-pattern_type` and `-loop` belong to `image2`, `safe`
// belongs to `concat` — so these rows write into the same bag `-probesize`
// goes in, and the option column beside them holds the same values. Given
// their own rows because the two or three that matter are otherwise three
// among seventy, and because *what they mean* is the point: a sequence's frame
// rate is a decision, and drawing it as row 34 of an option table says the
// opposite.

/// One demuxer option, edited as itself: the value goes into the bag under the
/// name ffmpeg gives it, and the command bar prints it in front of the `-i`.
function optionField(input, key, opts = {}) {
    const field = el('input', {
        cls: opts.wide ? 'wide' : 'num', 'data-f': opts.name || key, type: 'text',
        value: input.options[key] !== undefined ? String(input.options[key]) : '',
        placeholder: opts.hint || '',
        on: { change: () => {
            const next = Object.assign({}, input.options);
            const v = field.value.trim();
            if (v) next[key] = v; else delete next[key];
            change(input, { options: next });
        } },
    });
    return field;
}

function assemblyRows(input) {
    switch (kindOf(input)) {
        case 'sequence': return sequenceRows(input);
        case 'still':    return stillRows(input);
        case 'concat':   return concatRows(input);
        case 'device':   return deviceRows(input);
        case 'subtitles': return subtitleRows(input);
        default:         return [];
    }
}

/// A file of cues, which is an `-i` this stage can describe and the timeline
/// cannot use.
///
/// It is here because it *is* an `-i` — `ffmpeg -i clip.mp4 -i cues.srt` is how
/// everyone writes it, the demuxer can be forced, `-ss` shifts every cue, and
/// the command bar prints all of that in front of the same `-i` as everything
/// else. What it cannot be is a clip: there is no picture to lay out and no
/// sound to mix, and offering `Use on the timeline` would put a clip of nothing
/// on it.
///
/// So the panel says the two things it *can* be, and both are somewhere else:
/// a stream in the output, which is the Write stage, and a burn-in, which is a
/// `subtitles` filter on the Graph stage like every other filter.
function subtitleRows(input) {
    const cues = (input.probe ? input.probe.streams : [])
        .map((s) => `${s.index}: ${s.codec}${s.language ? ` (${s.language})` : ''}`);
    return [
        head('Subtitles'),
        div('src-note dim',
            'A file of cues. It is an ordinary -i — the demuxer, its options and -ss all ' +
            'reach it — but there is no picture to lay out and no sound to mix, so nothing ' +
            'is cut from it on the timeline.'),
        row('Tracks', span(cues.join(' · ') || 'none libavformat could read', 'mono')),
        div('src-note dim',
            'Two things can be done with it, and each belongs where the decision is taken. ' +
            'Add a subtitle stream on the Write stage and it travels beside the picture as ' +
            'a track a player can turn off — carried through as it is, or converted into ' +
            'what the container holds. Or burn it into the picture with a subtitles filter ' +
            'on the Graph stage, which makes it part of the image and works in any ' +
            'container.'),
        row('As a filter', span(`subtitles=${filterPath(input.path)}`, 'mono')),
        div('src-actions', el('button', {
            cls: 'tiny', 'data-f': 'srcburn', text: 'Burn it into the picture',
            title: 'Put a subtitles filter on the whole canvas, after compositing',
            on: { click: () => burnIn(input) },
        })),
        div('src-note dim',
            'That places an ordinary node on the graph, at the point where the whole canvas ' +
            'is — nothing private, nothing this stage keeps to itself. The colon in a drive ' +
            'letter is escaped and the path is quoted because a filtergraph separates a ' +
            'filter’s arguments with colons and its filters with commas, which is a trap ' +
            'whose error message names half a path and never mentions the colon.'),
    ];
}

/// The short way to `subtitles=`, and it is short only in the sense that it
/// knows the name of the filter and how to write the path.
///
/// **What it places is an ordinary node**, at `composite/after-overlay`, which
/// is the same point the palette offers and the same one a measurement lands
/// at. It appears on the Graph stage, it is printed by the command bar, it can
/// be moved, configured and deleted there, and nothing about the render behaves
/// differently because this button rather than the palette put it there — the
/// rule chunk 10's measurement offers follow, for the same reason: a shortcut
/// that produced something you could not then find is worse than no shortcut.
function burnIn(input) {
    graph.insert('composite/after-overlay', 'subtitles',
                 { params: { filename: filterPath(input.path) } });
    if (hooks.changed) hooks.changed();
    goTo('graph');
}

/// A live device, which is an input this stage can describe and cannot use.
///
/// It is here because a device *is* an `-i` and this is where an `-i` is
/// edited: forcing `-f dshow` by hand is a legitimate thing to do and the
/// result should be understood rather than shown as a file that will not open.
/// What it says is what is different about it — no end, so no clip — and where
/// to go instead.
function deviceRows(input) {
    return [
        head('Device'),
        row('Demuxer', span(`-f ${input.format} · libavdevice`, 'mono')),
        row('', span(
            'A device never ends, so nothing can be cut from it: there is no length for a ' +
            'clip to have and no way to seek back to a moment that has already gone. That is ' +
            'not a gap in this stage — it is what a live input is.', 'dim')),
        row('', span(
            'The Capture stage is where one is watched and recorded. What it writes is a ' +
            'file, and a file is an input like any other.', 'src-missing')),
    ];
}

/// A numbered run of files, as the one `-i` it is.
function sequenceRows(input) {
    const seq = input.sequence;
    const rows = [head('Image sequence')];

    if (seq && seq.count) {
        rows.push(row('Frames', span(
            `${seq.count} on disk, ${seq.start}…${seq.end}`, 'mono')));
        // A gap is reported and never closed. image2 stops at the first
        // missing number, so a run of three hundred with twelve absent is not
        // three hundred frames — and a length nothing will render is worse
        // than a number that looks short.
        if (seq.missing)
            rows.push(row('', span(
                `${seq.missing} number${seq.missing === 1 ? ' is' : 's are'} missing between ` +
                `${seq.start} and ${seq.end} — image2 stops at the first gap, so this ` +
                'sequence ends there', 'src-missing')));
    }

    // **The rate of a sequence is an input option, not a property of the
    // files.** Twelve pictures are twelve pictures; how long each is on screen
    // is a decision, and the same files are one second or two depending only
    // on this. It is the single most important sentence on this stage.
    rows.push(row('-framerate', optionField(input, 'framerate', {
        name: 'seqfps', hint: String(SEQUENCE_FPS),
    })));
    rows.push(row('', span(
        'A sequence has no frame rate of its own — nothing on disk says how long each ' +
        'picture is on screen. This is what decides it, and it is an input option: the ' +
        'same files are one second or two depending only on what is here.', 'dim')));

    rows.push(row('-start_number', optionField(input, 'start_number', {
        name: 'seqstart', hint: '0',
    })));
    rows.push(row('', span(
        'Which number the run begins at. image2 looks for the first five numbers from ' +
        'zero and then gives up, so a run beginning at 1000 is unopenable without it — ' +
        'and one beginning at 1 opens only by accident.', 'dim')));

    // `pattern_type` is the demuxer's own option and its values are the
    // demuxer's own; whether `glob` *works* is a compile-time fact about this
    // build and the only capability in this application that has to be asked
    // by trying. Offering it where it cannot work would be offering something
    // that fails at open with a sentence about a file.
    const pattern = input.options.pattern_type || 'sequence';
    rows.push(row('-pattern_type', div('src-demux', [
        segmented('src-pattern', [
            { v: 'sequence', l: 'sequence', title: 'A number in the name — %04d' },
            { v: 'glob', l: 'glob', disabled: !bro.ffmpeg.globPatterns,
              title: bro.ffmpeg.globPatterns ? 'A shell pattern — frame*.png'
                                             : 'This build has no globbing' },
        ], pattern, (id) => {
            const next = Object.assign({}, input.options);
            if (id === 'sequence') delete next.pattern_type; else next.pattern_type = id;
            change(input, { options: next });
        }),
    ])));
    if (!bro.ffmpeg.globPatterns)
        rows.push(row('', span(
            'This build of libavformat was compiled without globbing, so pattern_type=glob ' +
            'is refused at open. Numbered patterns are unaffected.', 'dim')));
    return rows;
}

/// One picture, held. The only input on this stage whose length is not a fact.
function stillRows(input) {
    const held = endless(input);
    const seconds = el('input', {
        cls: 'num', 'data-f': 'stillhold', type: 'text',
        value: input.to ? String(input.to) : '',
        placeholder: 'seconds',
        on: { change: () => {
            // The hold is `-loop 1` and `-t` together, so setting one sets
            // both: a `-t` on an input that does not loop is a window on one
            // picture and still no time at all.
            const next = Object.assign({}, input.options, { loop: '1' });
            if (!next.framerate) next.framerate = String(SEQUENCE_FPS);
            change(input, { to: Number(seconds.value) || 0, options: next,
                            format: input.format || 'image2' });
        } },
    });

    return [
        head('Still'),
        row('Hold for', seconds),
        row('', span(
            'A still has no duration of its own — it is a decision, not a fact. -loop 1 ' +
            'makes the input go on producing the same picture forever and -t is the only ' +
            'thing that can say how long it is; either without the other is a clip that ' +
            'cannot be laid out.', 'dim')),
        row('-framerate', optionField(input, 'framerate', {
            name: 'stillfps', hint: String(SEQUENCE_FPS),
        })),
        held ? null : row('', span(
            'Not looping: this input is one picture and no time at all. bro’s <video> ' +
            'drives its clock from decoded pictures, so there is nothing here for it to ' +
            'advance through — set a hold above.', 'src-missing')),
    ].filter(Boolean);
}

/// Several files as one input, through the concat demuxer.
function concatRows(input) {
    const parts = input.parts || [];
    return [
        head('Concat list'),
        row('Files', span(String(parts.length || '—'), 'mono')),
        ...parts.map((p, i) => row(String(i), span(p, 'mono dim'))),
        row('List', span(input.path, 'mono dim')),
        // The distinction this application exists to make legible. All three
        // are reachable from here and they are three different renders.
        row('', span(
            'The concat *demuxer* reads these files as one input, before any decoding, ' +
            'and wants them encoded compatibly. The concat *filter* joins decoded streams ' +
            'inside the graph and does not care what they were. Two clips laid end to end ' +
            'on the timeline is neither — that is an edit, and it goes through the ' +
            'compositor.', 'dim')),
        row('', span(
            'Each entry carries its own duration, because without one the demuxer reports ' +
            'no length at all until something has read to the end of the last file.',
            'dim')),
    ];
}

/// The window: which part of the input there is.
/// Where this input's pictures are decoded — `-hwaccel`, and the two words that
/// go with it.
///
/// **Here rather than on the Encode stage, because a decoder belongs to an
/// input.** ffmpeg writes `-hwaccel` in front of the `-i` for the same reason it
/// writes `-probesize` there, and two clips cut from one file cannot be decoded
/// one way and the other.
///
/// **And the cost is stated where the choice is made.** Every application with
/// a "hardware acceleration" switch reads as offering an optimisation; on this
/// machine, measured, decoding on the card is several times *slower* than
/// libavcodec threaded across every core, and the readback everybody blames for
/// that is 3–4% of it. Saying nothing would be the dishonest option. The device
/// is still offered, because the numbers are this machine's and somebody else's
/// laptop with four cores and a QSV block has different ones — and because it is
/// the only way to feed a hardware filter graph without an upload.
function decodeRows(input) {
    const codec = input.probe && input.probe.video && input.probe.video.codec;
    const usable = devicesFor(input);
    const rows = [head('Decoding')];

    // Only what this machine has *and* can decode this codec with. A menu
    // offering `cuda` for a ProRes file is a menu that fails at the last step,
    // and the two RTX 4090s in this machine still have no CUDA ProRes decoder.
    const choices = [{ id: '', label: 'CPU' }]
        .concat(usable.map((d) => ({ id: d.name, label: d.name })));
    const picker = select({
        'data-f': 'srchw',
        on: { change: () => change(input, {
            hwaccel: picker.value,
            // The output format goes with the device that named it. Left
            // behind, it is a pixel format belonging to a device this input no
            // longer decodes on, which the native side refuses — correctly, and
            // confusingly.
            hwaccelOutputFormat: '',
        }) },
    }, choices, input.hwaccel || '');
    rows.push(row('-hwaccel', picker));

    if (!usable.length)
        rows.push(row('', span(
            codec ? `Nothing on this machine decodes ${codec} on a device.`
                  : 'Nothing on this machine has a decoder for this input.', 'dim')));
    else
        rows.push(row('', span(decodeCost, 'dim')));

    if (input.hwaccel) {
        const dev = deviceNamed(input.hwaccel);
        const which = el('input', {
            cls: 'num', 'data-f': 'srchwdev', type: 'text', value: input.hwaccelDevice || '',
            placeholder: 'the default one',
            on: { change: () => change(input, { hwaccelDevice: which.value.trim() }) },
        });
        rows.push(row('-hwaccel_device', which));
        // The second decision, and the one that decides whether a render can
        // keep the picture on the card at all. Off, every frame comes down as
        // it is decoded, which is what the compositor, a software filter and
        // the viewer all need. On, only a graph of this device's own filters —
        // or an `hwdownload` — can read them.
        //
        // Two named states rather than a checkbox, because neither of them is
        // "the default with a thing switched on": bringing the picture down and
        // leaving it up are two different renders, and the second one is what
        // the value of `-hwaccel_output_format` literally is.
        rows.push(row('-hwaccel_output_format', segmented('srchwkeep', [
            { v: '', l: 'bring them down' },
            { v: dev ? dev.pixelFormat : '', l: `leave them on the card` },
        ], input.hwaccelOutputFormat || '',
            (v) => change(input, { hwaccelOutputFormat: v }))));
        rows.push(row('', span(
            'Leave the pictures on the card. Only ' +
            `${input.hwaccel}'s own filters, or an hwdownload, can read them — the ` +
            'compositor and the viewer cannot, so a clip on the timeline goes black. ' +
            'It is what lets a render reach a hardware encoder without a copy.',
            'dim')));
    }
    return rows;
}

function windowRows(input) {
    const number = (name, key, value, hint) => {
        const field = el('input', {
            cls: 'num', 'data-f': name, type: 'text', value: value ? String(value) : '',
            placeholder: hint,
            on: { change: () => change(input, { [key]: Number(field.value) || 0 }) },
        });
        return field;
    };

    const len = lengthOf(input);
    return [
        head('Window'),
        // Named as ffmpeg names them, because that is what they are and the
        // command bar prints them a foot below this.
        row('-ss', number('srcss', 'ss', input.ss, 'start of the file')),
        row('-to', number('srcto', 'to', input.to, 'end of the file')),
        row('-itsoffset', number('srcoffset', 'itsoffset', input.itsoffset, '0')),
        // The sentence this stage exists to make sayable. A clip's in-point and
        // an input's `-ss` are both "start later" and they are not the same
        // decision: one picks a moment out of an input, the other decides what
        // the input is.
        row('', span('An input seek is not a clip’s in-point: -ss moves this input’s zero, ' +
                     'so it is what a clip is cut *from*. -itsoffset delays it, which is how ' +
                     'a camera and a separate recorder are lined up.', 'dim')),
        // `-stream_loop` is the one thing here libavformat has never heard of:
        // ffmpeg's own CLI implements it by seeking the input back to the
        // start and shifting every timestamp forward, and so does this
        // binary's `InputLoop`. It belongs beside the window because it is the
        // other half of the same question — how much of this input there is.
        row('-stream_loop', number('srcloop', 'streamLoop', input.streamLoop, '0')),
        row('', span('How many more times to read this input after the first. -1 is forever, ' +
                     'and forever has no length — so an input that loops is as long as -to ' +
                     'says and no longer.', 'dim')),
        len ? row('Length', span(
            `${clock(len)} of input` + (endless(input) ? ' — because -to says so' : ''),
            'mono')) : null,
        !len && endless(input) ? row('', span(
            'This input never ends and nothing says how long it is, so there is nothing to ' +
            'lay out. Set -to above.', 'src-missing')) : null,
    ].filter(Boolean);
}

function actionRows(input) {
    const used = hooks.clipsOf ? hooks.clipsOf(input) : [];
    const inGraph = graphReads().has(input.id);
    return [row('', div('src-actions', [
        el('button', {
            cls: 'tiny primary', 'data-f': 'srcuse', text: 'Use on the timeline',
            disabled: !input.probe,
            on: { click: () => { if (hooks.use) hooks.use(input); } },
        }),
        el('button', {
            cls: 'tiny', 'data-f': 'srcreopen', text: 'Re-probe',
            on: { click: () => { reprobe(input); reopened(input); } },
        }),
        el('button', {
            cls: 'tiny', 'data-f': 'srcremove',
            text: used.length ? `In use by ${used.length}` : inGraph ? 'In the graph' : 'Remove',
            disabled: used.length > 0 || inGraph,
            title: used.length
                ? 'Delete the clips cut from it first — a clip with no input has nothing to decode'
                : inGraph
                ? 'A node on the Graph stage reads this one — delete that node first'
                : 'Take this input off the list',
            on: { click: () => {
                removeInput(input);
                chosenId = '';
                if (hooks.changed) hooks.changed();
                drawSources();
            } },
        }),
    ]))];
}

/// The demuxer's options, and the protocol's when the path is a URL.
///
/// One bag, because that is what libavformat is handed: whatever the demuxer
/// does not consume goes down to the AVIO layer, which is why `-rw_timeout`
/// next to `-probesize` is an ordinary thing to write on a command line.
function optionRows(input) {
    const demuxer = input.format || (input.probe ? input.probe.format.name : '');
    const out = [];
    if (demuxer) {
        const all = bro.ffmpeg.demuxerOptions(demuxer) || [];
        out.push(...optionColumn({
            name: 'demuxoptsearch',
            title: `${demuxer} options · ${all.length}`,
            note: 'What this demuxer takes beyond its defaults, out of its own option table ' +
                  'and libavformat’s generic one. An unknown key stops the open rather than ' +
                  'being ignored.',
            options: all,
            bag: input.options,
            hint: 'Anything set here is passed straight to the demuxer.',
            onChange: () => { reprobe(input); reopened(input); },
        }));
    }

    // The decoders, which are a different object from the demuxer and have a
    // different table. They belong here rather than on the Encode stage for the
    // reason `-probesize` does: a decoder is opened *for this input*, ffmpeg
    // writes `-skip_frame` in front of the same `-i`, and a bag that lived
    // beside the encoder's would be describing the wrong end of the pipeline.
    //
    // One column per codec this input turned out to carry, because the tables
    // are the codecs' — h264's `is_avc` and aac's `dual_mono_mode` are not the
    // same list — and the bag is shared, exactly as the demuxer's and the
    // protocol's share one: libavcodec is handed one dictionary per decoder and
    // an option no decoder took is what stops the open.
    for (const codec of decoderNames(input)) {
        const all = decoderOptionsFor(codec);
        if (!all.length) continue;
        out.push(...optionColumn({
            name: `decoptsearch-${codec}`,
            title: `${codec} decoder options · ${all.length}`,
            note: 'What the decoder reading this input takes — `skip_frame`, ' +
                  '`skip_loop_filter`, `thread_type`, `lowres`. These reach playback and ' +
                  'the render alike, because both open this input’s decoders the same way.',
            options: all,
            bag: input.decoderOptions,
            hint: 'Anything set here is passed straight to the decoder.',
            // Through `reprobe` even though the probe itself will say the same
            // thing: what it also does is re-register the input for playback,
            // and the token is the only route an option has into the `<video>`
            // elements the viewer is already holding.
            onChange: () => { reprobe(input); reopened(input); },
        }));
    }

    const scheme = schemeOf(input.path);
    if (scheme) {
        const all = bro.ffmpeg.protocolOptions(scheme) || [];
        if (all.length)
            out.push(...optionColumn({
                name: 'protooptsearch',
                title: `${scheme} options · ${all.length}`,
                note: 'The protocol’s own — timeouts, certificates, buffer sizes. They travel ' +
                      'in the same bag as the demuxer’s, which is what libavformat does with ' +
                      'what it does not recognise.',
                options: all,
                bag: input.options,
                hint: 'Anything set here is passed straight to the protocol.',
                onChange: () => { reprobe(input); reopened(input); },
            }));
    }
    return out;
}

/// Which decoders will read this input, by the names libavcodec answers to.
///
/// Out of the probe, so it is the codecs that are actually in the file rather
/// than the ones a container usually holds. Distinct, because a file with two
/// AAC tracks is one option table and not two.
function decoderNames(input) {
    const p = input.probe;
    if (!p) return [];
    const out = [];
    for (const s of p.streams)
        if (s.codec && (s.kind === 'video' || s.kind === 'audio') && out.indexOf(s.codec) < 0)
            out.push(s.codec);
    return out;
}

// Cached per decoder, for the reason the encoder's and the muxer's are: the
// panel is rebuilt on every keystroke in a search box and h264 has forty-five
// options.
const decoderOptionCache = new Map();

function decoderOptionsFor(name) {
    if (!decoderOptionCache.has(name)) {
        try {
            decoderOptionCache.set(name, bro.ffmpeg.decoderOptions(name) || []);
        } catch (e) {
            decoderOptionCache.set(name, []);
        }
    }
    return decoderOptionCache.get(name);
}

/// Apply a change and put back everything downstream of it.
function change(input, patch) {
    if (updateInput(input, patch)) reopened(input);
    else drawSources();
}

function reopened(input) {
    if (input.error && hooks.flash) hooks.flash(input.error);
    if (hooks.reopened) hooks.reopened(input);
    drawSources();
}

// ── what it turned out to contain ──────────────────────────────────────────

function contentRows(input) {
    if (input.error)
        return [head('What came back'),
                div('src-error', input.error),
                div('dim', 'The demuxer, the options and the window above are what this ' +
                           'input is opened with. Change one and it is tried again.')];
    if (!input.probe) return [];
    return fileRows(input.probe);
}

function fileRows(p) {
    return [
        head('Container'),
        row('Format', p.format.longName || p.format.name),
        row('Name', span(p.format.name, 'mono')),
        row('Duration', clock(p.format.duration)),
        row('Size', bytes(p.format.size)),
        row('Bitrate', p.format.bitRate ? kbps(p.format.bitRate) : '—'),
        row('Streams', String(p.streams.length)),
        ...p.streams.map(streamRows),
    ];
}

/// One stream, in the terms that stream is described in. Kept verbatim from
/// probe(): "Untagged" and "BT.601" are different facts, and this is the screen
/// where the difference is the point.
function streamRows(s) {
    const rows = [
        head(`${s.kind} #${s.index}` + (s.language ? ` · ${s.language}` : '')),
        row('Codec', s.codecLong || s.codec),
        s.profile && row('Profile', s.profile),
        s.duration && row('Duration', s.duration.toFixed(3) + ' s'),
    ];
    if (s.kind === 'video') {
        rows.push(row('Size', `${s.width}×${s.height}` +
            (s.rotation ? ` → ${s.displayWidth}×${s.displayHeight} (${s.rotation}°)` : '')));
        rows.push(row('Frame rate', s.fps ? s.fps.toFixed(3) + ' fps' : '—'));
        rows.push(row('Pixels', s.pixFmt || '—'));
        if (s.sampleAspect && Math.abs(s.sampleAspect - 1) > 0.001)
            rows.push(row('Pixel AR', s.sampleAspect.toFixed(4)));
        // What the render has to convert out of, and the reason the filtergraph
        // can be written faithfully at all — worth 13 dB, and invisible
        // everywhere else in the application.
        if (s.colorSpace || s.colorRange)
            rows.push(row('Colour', [s.colorSpace || 'untagged',
                                     s.colorRange || 'range untagged'].join(' · ')));
    } else if (s.kind === 'audio') {
        rows.push(row('Rate', s.sampleRate + ' Hz'));
        rows.push(row('Channels', `${s.channels} (${s.channelLayout || 'unknown'})`));
        rows.push(row('Samples', s.sampleFmt || '—'));
    }
    if (s.bitRate) rows.push(row('Bitrate', kbps(s.bitRate)));
    if (s.title) rows.push(row('Title', s.title));
    return rows;
}
