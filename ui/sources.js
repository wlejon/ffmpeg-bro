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
//   - **An input seek is not a clip's in-point.** `-ss` decides what the input
//     *is*: its zero moves, its duration shrinks, and the clips cut from it are
//     measured from there. Trimming a clip picks a moment out of an input.
//   - **The probe is the answer to what the options just did.** It is re-run
//     with the options in force, so the stream list under them is the file as
//     this input opens it and not as libavformat's defaults see it.
//
// ── What this stage says, and what it stopped saying ───────────────────────
//
// Both of those used to be **paragraphs on the screen**, and so did nine more:
// what a device is, what a sequence's frame rate means, which of the three
// concats this one is, where a decoder option reaches, why hardware decoding is
// usually slower here. Every one true, and together they were the stage — three
// hundred words with the controls scattered through them, the primary action
// (`Use on the timeline`) sitting mid-column at the weight of an ordinary
// button, and the file's own streams pushed off the bottom by the prose
// explaining the fields above them.
//
// The rule is the Capture stage's, arrived at the same way: **a stage states, a
// manual explains.** What is on screen is a label, a value, and a door to
// whatever would change it. A sentence that was load-bearing is a `title` on
// the control it is about — where somebody looking at the control will find it
// — and the argument lives in docs/manual/sources.md and in these headers.
//
// The vocabulary went with it. `-ss`, `-to`, `-itsoffset`, `-stream_loop`,
// `-hwaccel`, `-framerate` and `-start_number` were the *labels* of the fields,
// which is a UI legible only to somebody who did not need it. They are **Start
// at**, **Stop at**, **Delay by**, **Repeat**, **Decode on**, **Rate** and
// **First number** now, each carrying its ffmpeg spelling in its tooltip — and
// the exact line is a foot below in the command bar, which is the honest place
// for it. What stayed in ffmpeg's own words is the `-i` **number** on a list
// card, because the graph genuinely calls an input `[1:v]`, and the one-line
// `summary()` under it, because "what is set on this input" is precisely a list
// of flags and any translation of it would be a second answer.
//
// What it turned out to contain went from six rows a stream to **one line a
// stream** — `V0  h264  1920×1080 · 29.97 fps · yuv420p · bt709` — with the
// profile, the language, the colour range and the pixel aspect in its tooltip.
// The rows were not wrong; a file with two video tracks and five soundtracks
// was forty rows of them, and nothing in this stage is read as often as "what
// is in this file".
//
// ── the probe and the reads are two sections ───────────────────────────────
//
// And then that readout was broken in half again, by the controls that
// had each been drawn under the stream they read: `Read it` under a `gpmd`
// track, and `Find sounds` under the first soundtrack.
// Each argued its position and each argument was locally right — the control
// that dispatches on a fourcc belongs beside the fourcc.
//
// In aggregate it was wrong, because the two things are not the same kind of
// thing. **A probe answer is free and complete**: it is what libavformat said
// the instant the input was opened, under the options above. **A read is
// between thirty milliseconds and ninety minutes of this machine**, spent
// because somebody pressed a button, derived rather than part of the edit, and
// forgettable. Interleaving them put controls between `A0` and `V1`.
// So `fileRows` is the probe and `readRows` is what has been spent on it, and
// the section head is the whole of what makes the difference legible. A read's row can
// **name the stream it read** (the old ones sat under the first soundtrack and
// asserted by position an answer `av_find_best_stream` had not given).

import { div, span, el, put, row, head, fromTemplate, show, segmented,
         select } from './dom.js';
import { devicesFor, deviceNamed, decodeCost, deviceIndices,
         unknownDeviceIndex } from './hardware.js';
import { clock, bytes, kbps, basename } from './format.js';
import { inputs, addInput, updateInput, reprobe, removeInput, summary, schemeOf,
         lengthOf, kindOf, endless, opening, stopOpening, tickInputs } from './inputs.js';
import { typedSpec, concatSpec, SEQUENCE_FPS } from './sequence.js';
// A stream site's page URL is not something libavformat opens; one request turns
// it into one this build already can. See ui/vod.js.
import { looksLikePage, resolve as resolveVod } from './vod.js';
import { copiesOf, cancel as cancelCopy, tickLocalCopies,
         copyFolder, useCopyFolder, PULL_WORDS } from './localcopy.js';
// Which inputs a recording reads. The same question `graphReads()` asks of the
// overlay, asked of the other thing that reads an `-i` without a clip being cut
// from it — and it is only answerable at all because a device now lands in this
// list rather than in a private one on that stage.
import { capture } from './capture.js';
import { optionColumn } from './opttable.js';
// The same note the Write stage's rows are written with. Imported rather than
// written again: a second one would be a second answer to how a paragraph under
// a control is styled, and the two would drift on the first change to either.
import { note } from './export/controls.js';
import * as graph from './graph/overlay.js';
import { COMPOSITE_POINT } from './graph/derive.js';
import { streamsOf } from './export/streams.js';
import { readsInput, filterPath } from './export/subtitles.js';
import { goTo } from './shell.js';
import { streamsWorthReading, readingOf, readStream, dropReading, tickTelemetry,
         isPicked, pick, labelOf } from './telemetry.js';

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
        const added = (input) => {
            refs.addPath.value = '';
            chosenId = input.id;
            if (input.error && hooks.flash) hooks.flash(input.error);
            if (hooks.changed) hooks.changed();
            drawSources();
        };
        const add = () => {
            const path = refs.addPath.value.trim();
            if (!path) return;
            // **A page from a stream site is opened by resolving it first.**
            // `https://www.twitch.tv/videos/…` is HTML, and handing it to
            // libavformat gets "Invalid data found when processing input" —
            // which is true and useless. One request turns it into an HLS URL
            // this build can already open, so the application does that rather
            // than sending somebody away for a downloader. Nothing is fetched
            // but the playlist: what comes back is a URL and it is opened as
            // one. See ui/vod.js.
            if (looksLikePage(path)) return addPage(path);
            // Typing `shot_%04d.png` means a sequence in exactly the way
            // dropping the folder does, and a path that is one picture means a
            // still. Anything else is a file or a URL and nothing is added to
            // it — see ui/sequence.js.
            added(addInput(typedSpec(path)));
        };

        /// Resolve a page and add what it names.
        ///
        /// Asynchronous, and the field is left holding what was typed until it
        /// lands: the request is one round trip but it is a *network* round
        /// trip, and a field that emptied itself before the answer came back
        /// would leave somebody looking at an empty stage wondering whether
        /// they had pressed the button.
        const addPage = (page) => {
            if (hooks.flash) hooks.flash('Asking the site about that link…');
            resolveVod(page).then((vod) => {
                added(addInput({
                    path: vod.url,
                    // The readable half. The URL it is opening is a signed
                    // playlist that expires; this is what it came from.
                    name: vod.label,
                    origin: vod.page,
                    // **All of them, not just the one being opened.** One
                    // recording is two jobs — the picture for the cut, the sound
                    // alone for a transcription at a fraction of the bytes — and
                    // a resolver that answered with the best stream and dropped
                    // the rest made the second one cost the first one's
                    // bandwidth. They were already being counted in the flash
                    // message below and then thrown away.
                    renditions: vod.renditions,
                    rendition: vod.renditions[0].name,
                }));
                if (hooks.flash)
                    hooks.flash(`${vod.label} — ${vod.renditions.length} renditions, ` +
                                `opened at ${vod.renditions[0].name}`);
            }).catch((e) => {
                // Named rather than swallowed: a VOD that is deleted, private
                // or subscriber-only is a different answer from a link that was
                // mistyped, and only the site can tell them apart.
                if (hooks.flash) hooks.flash(String((e && e.message) || e));
            });
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

// The `<span>`s showing how long an open has been waiting, by input id. Held
// rather than redrawn, because the alternative is relaying out this stage sixty
// times a second to move one number — and most of the window is `display:none`
// at any moment, so a redraw here is not a redraw of a card.
const waitingText = new Map();

/// Take in whatever the opens in flight have said, and keep the clocks moving.
///
/// From the frame loop, for the reason the render's poll is: nothing calls back
/// into JS, so this is the only way an answer that arrived on another thread
/// reaches the screen. It runs wherever you are standing — an input typed on
/// this stage goes on connecting while you walk to the timeline, exactly as a
/// render goes on rendering.
export function tickSources() {
    // Every poll runs, and none is allowed to skip another: a probe settling, a
    // data read settling and a soundtrack read settling are three answers
    // arriving on three threads, and `||` would leave one of them unpolled for a
    // frame whenever another went first.
    const opened = tickInputs();
    const read = tickTelemetry();
    const pulled = tickLocalCopies();
    const settled = opened || read || pulled;
    if (settled) {
        waitingText.clear();
        drawSources();
        if (hooks.changed) hooks.changed();
        return;
    }
    for (const [id, node] of waitingText) {
        const input = inputs.find((i) => i.id === id);
        if (input && input.opening) node.textContent = waitingLabel(input);
    }
}

/// What an open in flight is waiting *on*, which is not decoration: the two
/// kinds wait on different things, and only one of them can be cut short.
///
/// A URL is connecting — to a host, through a protocol, and a Stop reaches the
/// socket libav is sitting on. A device is opening — a driver is being asked
/// for a picture, and libavdevice's `read_header` never polls the interrupt
/// callback, so a Stop there ends the waiting and not the open. One word each,
/// so that what is on screen is the truth about which wait this is.
function waitingOn(input) { return kindOf(input) === 'device' ? 'device' : 'url'; }

/// "Connecting · 3.4s of 10", or the same without the deadline until the first
/// poll has said what the deadline is.
function waitingLabel(input) {
    const o = input.opening || {};
    const secs = `${(o.elapsed || 0).toFixed(1)}s`;
    const verb = waitingOn(input) === 'device' ? 'Opening' : 'Connecting';
    return o.timeout > 0 ? `${verb} · ${secs} of ${o.timeout.toFixed(0)}` : `${verb} · ${secs}`;
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
                div('src-empty', [
                    div('src-empty-title', 'No inputs'),
                    div('src-empty-note dim', 'Type a path above, or drop a file.'),
                ]),
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
            const set = node.querySelector('.src-set');
            set.textContent = summary(input);
            set.title = 'What is set on this input, in ffmpeg’s own words — ' +
                        'everything the command bar prints in front of its -i';
            // A file of cues is never cut into a clip and is used all the same
            // — by a stream row on the Write stage, or by a `subtitles=` node
            // burning it into the picture. Both are counted, because "unused"
            // beside a file the render is about to open is the one thing this
            // stage cannot afford to get wrong, and a subtitle file would
            // otherwise read that way permanently.
            const written = subtitleWriters.has(inputs.indexOf(input));
            // A device the Capture stage has activated is read by the
            // recording, which is a use this list would otherwise not know
            // about — and "unused" beside a camera that is about to be
            // recorded is the same mistake as "unused" beside a logo the
            // render is about to open. It is asked of the capture rather than
            // guessed from `kindOf`, because a `-f dshow` forced here by hand
            // is a device nothing is recording and should say so.
            const recorded = capture.inputs.indexOf(input.id) >= 0;
            const use = node.querySelector('.src-used');
            use.textContent =
                opening(input) ? (waitingOn(input) === 'device' ? 'opening' : 'connecting')
                : input.error ? 'unreadable'
                : [used ? `${used} clip${used === 1 ? '' : 's'}` : '',
                   recorded ? 'recording' : '',
                   written ? 'written' : '',
                   inGraph ? 'in the graph' : ''].filter(Boolean).join(' · ') || 'unused';
            use.title =
                opening(input) ? 'the open is on a thread of its own — nothing here is blocked'
                : input.error ? input.error
                : [used ? `${used} clip${used === 1 ? ' is' : 's are'} cut from it` : '',
                   recorded ? 'activated for a recording on the Capture stage' : '',
                   written ? 'a stream row on the Write stage reads it' : '',
                   inGraph ? 'a node on the Graph stage reads it' : '']
                    .filter(Boolean).join('\n') ||
                  'nothing is cut from it — which is an ordinary state';
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
/// `'C\:/logo.png'` is how a Windows path has to be written inside a filter
/// argument: a colon separates a filter's arguments, and the quotes are there
/// because a comma ends the filter and a filename is free to contain one. What
/// is wanted here is the path.
///
/// **Both layers, or the round trip does not close.** `filterPath()` in
/// `export/subtitles.js` writes the quotes and this took only the backslashes
/// off, so `Add as an input` handed `addInput` a path with a leading apostrophe
/// on it and the open failed on a filename nobody had typed.
function unescapePath(text) {
    let s = String(text || '').trim();
    if (s.length > 1 && s[0] === '\'' && s[s.length - 1] === '\'') s = s.slice(1, -1);
    return s.replace(/\\(.)/g, '$1');
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
        head('Opened by the graph', {
            title: 'A movie filter opens its file inside libavfilter, so nothing on this ' +
                   'stage reaches it: no forced demuxer, no -probesize, no window, no probe. ' +
                   'Added as an input it gets all of them, and the graph can read it as ' +
                   '[n:v] instead.',
        }),
        ...nodes.map((n) => {
            const named = (n.params && n.params.filename) || (n.pos && n.pos[0]) || '';
            const path = unescapePath(named);
            return div('src-demux', [
                span(n.filter, 'mono'),
                span(path || 'no file named yet', path ? 'dim' : 'src-missing'),
                path ? el('button', {
                    cls: 'tiny', 'data-f': 'srcadopt', text: 'Add',
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
        // Three different things in this application are called concat and they
        // are three different renders. Which one this is has to be sayable
        // where it is offered — as a tooltip on the heading rather than the
        // four lines of prose it was, because the panel is a list of ticks and
        // a paragraph above them is the thing nobody reads.
        head('Read end to end', {
            title: 'The concat demuxer reads these files one after another as a single -i, ' +
                   'before anything is decoded — so they have to be encoded compatibly.\n\n' +
                   'The concat filter joins decoded streams inside the graph and does not ' +
                   'care what they were.\n\nTwo clips laid end to end on the timeline is ' +
                   'neither: that is an edit, and it goes through the compositor.',
        }),
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
        rows.push(div('dim pad', 'Add two files first.'));

    rows.push(div('src-actions', [
        el('button', {
            cls: 'tiny primary', 'data-f': 'srcjoingo', text: 'Join',
            title: 'Write a concat list and add it as one input',
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
    // Nothing at all, rather than a second empty state: `chosen()` falls back to
    // the first input, so this is reachable only when the list is empty — and
    // the list is already saying so, in the column that owns the question.
    if (!input) {
        put(refs.detail, () => []);
        put(refs.options, () => []);
        put(refs.foot, () => []);
        return;
    }

    put(refs.detail, () => [
        // The filename as it is written, not shouted: `.section-head` sets its
        // text in caps, which is right for `WINDOW` and wrong for
        // `MY_HOLIDAY_CLIP_FINAL_2.MP4`.
        head(input.name, { cls: 'section-head src-title', title: input.path }),
        ...whereRows(input),
        ...localCopySection(input),
        ...demuxerRows(input),
        ...assemblyRows(input),
        ...decodeRows(input),
        ...windowRows(input),
        ...contentRows(input),
        ...readRows(input),
    ]);

    // The act, pinned under the column rather than laid out among the rows.
    put(refs.foot, () => footRows(input));

    // The demuxer's own option table, beside the input rather than under it,
    // for the reason the encoder's and the muxer's are: mp4's demuxer has
    // thirty options and libavformat's generic table another forty, and a fold
    // is not somewhere anybody reads seventy rows.
    put(refs.options, () => optionRows(input));
}

/// One line stating a fact this stage cannot change, with the door to whatever
/// can. The Capture stage's `.cap-strip` in the Sources vocabulary, and it
/// exists for the same reason: the two inputs that are not a clip and never
/// will be — a device, a file of cues — were each answered with two paragraphs
/// naming the stage to go to, and a paragraph is not a door.
function strip(key, text, why, door) {
    return div('src-strip', [
        span(key, 'src-strip-k'),
        el('span', { cls: 'src-strip-v dim', text, title: why || '' }),
        door || null,
    ]);
}

const doorTo = (label, stage, why) => el('button', {
    cls: 'tiny', 'data-f': `srcgo${stage}`, text: label, title: why,
    on: { click: () => goTo(stage) },
});

/// Where it comes from, and what is answering for that.
function whereRows(input) {
    const path = el('input', {
        cls: 'wide', 'data-f': 'srcpath', type: 'text', value: input.path,
        title: 'What -i is handed, exactly as written',
        on: { change: () => change(input, { path: path.value.trim() }) },
    });
    const rows = [row('From', path)];

    const scheme = schemeOf(input.path);
    const protocols = (bro.ffmpeg.protocols && bro.ffmpeg.protocols.input) || [];
    // Only for a URL. "Protocol: file" under every path on the machine is a row
    // that has never once been the answer to anything.
    if (scheme) {
        // A URL naming a protocol this build does not have fails at open with a
        // message about a filename, which is the least helpful place to find
        // out. Every protocol here is one `avio_enum_protocols` reported.
        const known = protocols.indexOf(scheme) >= 0;
        rows.push(row('Over', el('span', {
            cls: known ? 'mono' : 'mono src-missing',
            text: known ? scheme : `${scheme} — not in this build`,
            title: known
                ? `libavformat links ${scheme}, one of ${protocols.length} input protocols`
                : `This build has no ${scheme} protocol, so the open fails with a message ` +
                  'about a filename',
        })));
    }
    rows.push(...renditionRows(input));
    if (opening(input)) rows.push(...waitingRows(input));
    return rows;
}

/// The other streams of the same recording, where the input came out of a page.
///
/// **Switching is a change of path and nothing more.** Every rendition is the
/// same recording — the same length, the same content, the same page — so
/// swapping one for another is exactly the edit `From` above already is, and it
/// goes through the same `change()` so the file is reopened and the clips
/// reading it are reloaded the way they would be for any other change of `-i`.
///
/// Two things it deliberately does not do. It does not re-resolve: the URLs came
/// back in one answer and are all signed with the same lifetime, so asking again
/// for the one you picked would be a second round trip for a string already in
/// hand. And it does not re-cut anything — the clips keep their times, which is
/// right within one file and is *not* right between two renditions of a Twitch
/// VOD, where the discontinuities where the ads were leave the clocks up to two
/// and a half seconds apart. That is why the row says so rather than the
/// application pretending the swap is free.
function renditionRows(input) {
    const list = input.renditions;
    if (!list || list.length < 2) return [];
    const at = list.findIndex((r) => r.url === input.path);
    const pick = el('select', {
        cls: 'wide', 'data-f': 'srcrendition',
        title: 'Another stream of the same recording',
        on: { change: () => {
            const r = list[Number(pick.value)];
            if (!r) return;
            input.rendition = r.name;
            change(input, { path: r.url });
        } },
    }, list.map((r, i) => el('option', {
        value: String(i),
        selected: i === at ? true : undefined,
        text: `${r.name}${r.audioOnly ? ' — sound only' : ''}` +
              (r.bandwidth ? ` · ${Math.round(r.bandwidth / 1000)} kb/s` : ''),
    })));
    return [
        row('Stream', pick),
        note(`${list.length} renditions of ${input.origin || 'this recording'}. ` +
             'They are the same recording at different rates — the sound-only one is a ' +
             'fraction of the bytes and is what a transcription pass wants. Times do not ' +
             'carry between two of them: a Twitch VOD’s renditions do not resolve the ' +
             'ad breaks identically and drift apart by seconds, so a cut made against one ' +
             'is a search hint against another and not a cut.'),
    ];
}

/// What is happening while an input is being opened, and the way to stop it.
///
/// **The Stop says what it does, and for a device that is less than it is for a
/// URL.** On a URL it reaches the `AVIOInterruptCB` the open was started with,
/// so libav abandons the connect, the handshake or the read it is inside and
/// the card says `stopped` a frame or two later. On a device it cannot: nothing
/// in libavdevice's `read_header` consults that callback, so what the press
/// ends is this application's waiting, and the thread stays inside libav until
/// the driver answers. A button that hid the row while the thread stayed
/// blocked would be worse than no button — it would say the machine had stopped
/// doing something it was still doing — so the row says both halves.
///
/// The elapsed figure is written into `waitingText` and updated from the frame
/// loop rather than redrawn, which is why it is built as its own node here.
function waitingRows(input) {
    const readout = span(waitingLabel(input), 'mono src-waiting');
    waitingText.set(input.id, readout);
    const device = waitingOn(input) === 'device';
    return [
        row(device ? 'Opening' : 'Connecting', readout),
        row('', el('button', {
            cls: 'tiny', 'data-f': 'srcstop', text: device ? 'Stop waiting' : 'Stop',
            title: device
                ? 'Stop waiting for this device. It does not abort the open — libavdevice ' +
                  'never asks libav’s interrupt callback while it is talking to a driver — ' +
                  'so the thread is abandoned and reaped when the device finally answers.'
                : 'Abandon the open. This reaches libav’s interrupt callback, which is ' +
                  'the only thing that can abort a connect that is already in progress.',
            on: { click: () => { stopOpening(input); } },
        })),
        row('', note(device
            ? 'The open is on a thread of its own, so the window stays alive while it waits. ' +
              'A device blocks in its own driver, where neither the deadline nor Stop can ' +
              'reach it; what they do reach is the stream analysis after it, which is most ' +
              'of an open on a screen grabber and about half of one on a camera.'
            : 'The open is on a thread of its own, so the window stays alive while it waits — ' +
              'and it gives up by itself if nothing answers in time. Name resolution is the ' +
              'one part neither the deadline nor Stop can cut short: getaddrinfo has no ' +
              'callback in it.')),
    ];
}

/// What it probed as, and what it can be forced to.
function demuxerRows(input) {
    const probed = input.probe ? input.probe.format.name : '';
    const rows = [row('Read as', div('src-demux', [
        el('span', {
            cls: input.format ? 'mono' : 'mono dim',
            text: input.format || probed || 'not read yet',
            title: input.format
                ? `-f ${input.format} — forced, so libavformat is not asked`
                : 'Probed: libavformat worked it out from the file itself',
        }),
        el('button', {
            cls: 'tiny', 'data-f': 'demuxpick',
            text: demuxerOpen ? 'Close' : 'Change…',
            title: `Force one of the ${(bro.ffmpeg.demuxers || []).length} demuxers this ` +
                   'build has, which is what -f means in front of an -i',
            on: { click: () => { demuxerOpen = !demuxerOpen; drawSources(); } },
        }),
        input.format && el('button', {
            cls: 'tiny', 'data-f': 'demuxprobe', text: 'Auto',
            title: 'Hand the choice back to libavformat',
            on: { click: () => change(input, { format: '' }) },
        }),
    ]))];

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
        placeholder: `name, description or extension`,
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
        // The ffmpeg name of the key, and what it decides, on the control it is
        // about — the row is labelled in words now, and the word is not the
        // spelling the command bar prints.
        title: opts.title || `-${key}`,
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
        row('Tracks', span(cues.join(' · ') || 'none libavformat could read', 'mono')),
        // The two homes, as two doors rather than as the two paragraphs that
        // named them. Each is a decision taken somewhere else, and telling
        // somebody to go there is worse than taking them.
        strip('Cues', 'no picture and no sound — nothing to lay out',
              'A file of cues is an ordinary -i: the demuxer, its options and Start at all ' +
              'reach it. What it cannot be is a clip.\n\n' +
              'Three things can be done with it. A subtitle stream on the Write stage ' +
              'travels beside the picture as a track a player can turn off. Burn in below ' +
              'draws it over the whole canvas, which is right for cues written against the ' +
              'finished programme. Burn in on a clip’s properties panel draws it on that ' +
              'clip, on the file’s own clock — which is right for an .srt that came with ' +
              'the shot, and is the one the viewer can show you.',
              doorTo('Write', 'write', 'Carry it as a track the player can turn off')),
        row('Burn in', div('src-demux', [
            el('span', {
                cls: 'mono dim src-filter', text: `subtitles=${filterPath(input.path)}`,
                title: 'The colon in a drive letter is escaped and the path quoted because ' +
                       'a filtergraph separates a filter’s arguments with colons and its ' +
                       'filters with commas',
            }),
            el('button', {
                cls: 'tiny', 'data-f': 'srcburn', text: 'Place it',
                title: 'Put an ordinary subtitles node on the graph, on the whole canvas ' +
                       'after compositing — movable, configurable and deletable there like ' +
                       'any other',
                on: { click: () => burnIn(input) },
            }),
        ])),
    ];
}

/// The short way to `subtitles=`, and it is short only in the sense that it
/// knows the name of the filter and how to write the path.
///
/// **Over the whole canvas, which is a statement about the clock.** These cues
/// are being drawn on the composite, where a cue at 00:01:30 is a minute and a
/// half into what will be *written*. That is right for a file authored against
/// the finished programme and wrong for one that came with a shot, and the
/// other door — `Burn in` on a clip's properties panel — is the second, on that
/// clip's own chain above the derivation's `setpts`. Nothing can ask a file
/// which of the two it is, so both exist and each says what it is for.
///
/// **What it places is an ordinary node**, at `COMPOSITE_POINT`, which is the
/// same point the palette offers and the same one a measurement lands at. It
/// appears on the Graph stage, it is printed by the command bar, it can be
/// moved, configured and deleted there, and nothing about the render behaves
/// differently because this button rather than the palette put it there — the
/// rule chunk 10's measurement offers follow, for the same reason: a shortcut
/// that produced something you could not then find is worse than no shortcut.
///
/// The anchor comes from `derive.js` rather than being written out, because
/// `applyOverlay` drops an insert whose point no derivation declares without a
/// word — right for a clip trimmed out of the range, and silent ruin for a name
/// that has drifted: this button would go on placing a record nothing ever
/// resolves, and the only symptom is that pressing it does nothing.
function burnIn(input) {
    graph.insert(COMPOSITE_POINT, 'subtitles',
                 { params: { filename: filterPath(input.path) } });
    if (hooks.changed) hooks.changed();
    goTo('graph');
}

/// A live device, which is an input this stage can describe and cannot lay out.
///
/// It is here because a device *is* an `-i` and this is where an `-i` is
/// edited: forcing `-f dshow` by hand is a legitimate thing to do and the
/// result should be understood rather than shown as a file that will not open.
///
/// **It used to say "no end, so no clip", and that was the wrong half.** `Stop
/// at` gives a device an end — it is `-t`, and `-t` is exactly what gives an
/// endless input a length everywhere else in this application — so the sentence
/// was answerable and the refusal it was standing in for was not. The half that
/// cannot be given is the seek: a libavdevice demuxer has no `read_seek`, every
/// scrub comes back `Invalid argument`, and a trim measured on the render is a
/// *wait* of exactly its own length (see `deviceClip` in
/// src/native/ffmpeg_export.h for the numbers). So this says the true thing and
/// points at the two places a live input does work.
function deviceRows(input) {
    return [
        strip('Live', 'plays now and cannot be cut',
              'A device has no way back to a moment that has gone. Stop at gives one a ' +
              'length, and a length was never what was missing: seeking a device is an ' +
              'error, so a trim on one would be a wait of its own length rather than a ' +
              'jump, and the picture on the monitor could never be the moment under the ' +
              'playhead. That is what a live input is, not a gap in this stage.\n\n' +
              'Live goes through the Capture stage instead, and it goes all the way ' +
              'through: several devices on one graph, a file over them in a movie node, ' +
              'and a destination that is a URL — so a camera with a title on it, streamed ' +
              'out, is that stage rather than this one. What it writes to a file is an ' +
              'input like any other, and that one can be cut.',
              doorTo('Capture', 'capture', 'Watch it, compose it, record or stream it')),
    ];
}

/// A numbered run of files, as the one `-i` it is.
function sequenceRows(input) {
    const seq = input.sequence;
    const rows = [head('Image sequence')];

    if (seq && seq.count) {
        rows.push(row('Frames', span(`${seq.count} · ${seq.start}…${seq.end}`, 'mono')));
        // A gap is reported and never closed. image2 stops at the first
        // missing number, so a run of three hundred with twelve absent is not
        // three hundred frames — and a length nothing will render is worse
        // than a number that looks short. Stays on the screen rather than
        // going into a tooltip: it is a refusal, not an explanation.
        if (seq.missing)
            rows.push(row('', el('span', {
                cls: 'src-missing',
                text: `${seq.missing} missing — the sequence ends at the first gap`,
                title: `${seq.missing} number${seq.missing === 1 ? ' is' : 's are'} missing ` +
                       `between ${seq.start} and ${seq.end}. image2 stops at the first gap, ` +
                       'so this input is shorter than the files on disk.',
            })));
    }

    // **The rate of a sequence is an input option, not a property of the
    // files.** Twelve pictures are twelve pictures; how long each is on screen
    // is a decision, and the same files are one second or two depending only
    // on this — which is the sentence this stage most has to be able to say.
    rows.push(row('Rate', [
        optionField(input, 'framerate', {
            name: 'seqfps', hint: String(SEQUENCE_FPS),
            title: '-framerate — a sequence has no frame rate of its own; nothing on disk ' +
                   'says how long each picture is on screen. The same files are one second ' +
                   'or two depending only on this.',
        }),
        span('fps', 'dim'),
    ]));

    rows.push(row('First number', optionField(input, 'start_number', {
        name: 'seqstart', hint: '0',
        title: '-start_number — which number the run begins at. image2 looks for the first ' +
               'five from zero and then gives up, so a run beginning at 1000 is unopenable ' +
               'without it, and one beginning at 1 opens only by accident.',
    })));

    // `pattern_type` is the demuxer's own option and its values are the
    // demuxer's own; whether `glob` *works* is a compile-time fact about this
    // build and the only capability in this application that has to be asked
    // by trying. Offering it where it cannot work would be offering something
    // that fails at open with a sentence about a file.
    const pattern = input.options.pattern_type || 'sequence';
    rows.push(row('Named by', div('src-demux', [
        segmented('src-pattern', [
            { v: 'sequence', l: 'number', title: 'pattern_type sequence — a number in the ' +
                                                 'name, %04d' },
            { v: 'glob', l: 'pattern', disabled: !bro.ffmpeg.globPatterns,
              title: bro.ffmpeg.globPatterns
                  ? 'pattern_type glob — a shell pattern, frame*.png'
                  : 'This build of libavformat was compiled without globbing, so ' +
                    'pattern_type=glob is refused at open. Numbered patterns are ' +
                    'unaffected.' },
        ], pattern, (id) => {
            const next = Object.assign({}, input.options);
            if (id === 'sequence') delete next.pattern_type; else next.pattern_type = id;
            change(input, { options: next });
        }),
    ])));
    return rows;
}

/// One picture, held. The only input on this stage whose length is not a fact.
function stillRows(input) {
    const held = endless(input);
    const seconds = el('input', {
        cls: 'num', 'data-f': 'stillhold', type: 'text',
        value: input.to ? String(input.to) : '',
        placeholder: '0',
        title: '-loop 1 with a -t. A still has no duration of its own — it is a decision, ' +
               'not a fact. The loop makes the input go on producing the same picture and ' +
               'this is the only thing that can say how long it lasts; either without the ' +
               'other is a clip that cannot be laid out.',
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
        row('Hold for', [seconds, span('s', 'dim')]),
        row('Rate', [
            optionField(input, 'framerate', {
                name: 'stillfps', hint: String(SEQUENCE_FPS),
                title: '-framerate — how many times a second the held picture is produced',
            }),
            span('fps', 'dim'),
        ]),
        // Not looping is a refusal and it is `blocked()`'s to make: the bar
        // under this column states it, and it is pinned, so a second copy here
        // is the same sentence twice in one glance.
    ].filter(Boolean);
}

/// Several files as one input, through the concat demuxer.
function concatRows(input) {
    const parts = input.parts || [];
    return [
        // The distinction this application exists to make legible, on the
        // heading because all three are reachable from here and they are three
        // different renders.
        head('Read end to end', {
            title: 'The concat demuxer reads these files as one input, before any decoding, ' +
                   'and wants them encoded compatibly.\n\nThe concat filter joins decoded ' +
                   'streams inside the graph and does not care what they were.\n\nTwo clips ' +
                   'laid end to end on the timeline is neither — that is an edit, and it ' +
                   'goes through the compositor.',
        }),
        ...parts.map((p, i) => row(String(i), span(p, 'mono dim'))),
        row('List', el('span', {
            cls: 'mono dim', text: input.path,
            title: 'Each entry carries its own duration, because without one the demuxer ' +
                   'reports no length at all until something has read to the end of the ' +
                   'last file.',
        })),
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
    // Nothing to say about an input with no pictures in it. `-hwaccel`
    // configures a video decoder, so "Decode on: CPU" over a file of cues or a
    // soundtrack is a control that has never once been the answer to anything.
    // Asked of the probe, so an input that has not been read yet still gets it.
    if (input.probe && !input.probe.video) return [];

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
        // The cost, measured, on the control that offers it. Every application
        // with a "hardware acceleration" switch reads as offering an
        // optimisation, and on this machine it is several times slower.
        title: usable.length
            ? `-hwaccel. ${decodeCost}`
            : codec ? `-hwaccel. Nothing on this machine decodes ${codec} on a device.`
                    : '-hwaccel. Nothing on this machine has a decoder for this input.',
        on: { change: () => change(input, {
            hwaccel: picker.value,
            // The output format goes with the device that named it. Left
            // behind, it is a pixel format belonging to a device this input no
            // longer decodes on, which the native side refuses — correctly, and
            // confusingly.
            hwaccelOutputFormat: '',
        }) },
    }, choices, input.hwaccel || '');
    rows.push(row('Decode on', picker));

    if (input.hwaccel) {
        const dev = deviceNamed(input.hwaccel);
        // **The cards this machine has, not a number typed into a box.**
        // `-hwaccel_device` has been settable since an input grew a device and
        // this was a text field, because nothing knew how many devices there
        // were: libavutil has no count and no iterator over the devices of a
        // type. It has one now — `bro.ffmpeg.hardware()` reports the indices it
        // could create one of — so this is a picker built from the same measure
        // the `Decode on` list above is, and a machine with one card sees that
        // there is one.
        const indices = deviceIndices(input.hwaccel);
        const stored = String(input.hwaccelDevice || '');
        const absent = unknownDeviceIndex(input.hwaccel, stored);
        // A type that does not address its devices by index answers with an
        // empty list, and the default is then the only device anybody can name.
        // The row stays and says so in its tooltip rather than disappearing:
        // a control that vanished would leave a stored value invisible.
        const choices = [{ id: '', label: 'the default' }]
            .concat(indices.map((i) => ({ id: i, label: `${input.hwaccel} ${i}` })));
        // **A value this machine cannot honour is shown, not snapped.** A
        // document written where there were two cards, opened where there is
        // one, carries `-hwaccel_device 1`; quietly selecting the default would
        // be a render pointed at a different card from the one the file says.
        // libav refuses it at the open either way — this is so the refusal is
        // on screen before the render rather than after it.
        if (absent) choices.push({ id: stored, label: `${stored} — not on this machine` });
        const which = select({
            'data-f': 'srchwdev',
            cls: absent ? 'bad' : '',
            title: indices.length > 1
                ? `-hwaccel_device. This machine has ${indices.length} ${input.hwaccel} ` +
                  'devices; a render is refused at the open if it names one that is not here.'
                : indices.length === 1
                    ? `-hwaccel_device. This machine has one ${input.hwaccel} device.`
                    : `-hwaccel_device. ${input.hwaccel} does not address its devices by ` +
                      'index here, so the default is the only one that can be named.',
            on: { change: () => change(input, { hwaccelDevice: which.value }) },
        }, choices, stored);
        rows.push(row('Which one', which));
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
        rows.push(row('Pictures', segmented('srchwkeep', [
            { v: '', l: 'bring down',
              title: 'Every frame comes down as it is decoded, which is what the ' +
                     'compositor, a software filter and the viewer all need' },
            { v: dev ? dev.pixelFormat : '', l: 'keep on the card',
              title: `-hwaccel_output_format. Only ${input.hwaccel}'s own filters, or an ` +
                     'hwdownload, can read them — the compositor and the viewer cannot, so ' +
                     'a clip on the timeline goes black. It is what lets a render reach a ' +
                     'hardware encoder without a copy.' },
        ], input.hwaccelOutputFormat || '',
            (v) => change(input, { hwaccelOutputFormat: v }))));
    }
    return rows;
}

function windowRows(input) {
    // A field, its unit, and the ffmpeg name of the key it writes. The unit is
    // beside the box rather than in the label because the label is now a word
    // — "Start at 1" is a number of nothing in particular, and every one of
    // these used to be labelled with the flag that said what it was.
    const number = (name, key, value, hint, why, unit) => {
        const field = el('input', {
            cls: 'num', 'data-f': name, type: 'text', value: value ? String(value) : '',
            placeholder: hint, title: why,
            on: { change: () => change(input, { [key]: Number(field.value) || 0 }) },
        });
        return [field, span(unit || 's', 'dim')];
    };

    const len = lengthOf(input);
    return [
        head('Window', { title: 'Which part of this input there is. Everything here is ' +
                                'settled while the file is being opened, and the command ' +
                                'bar prints all of it in front of the -i.' }),
        // The sentence this stage exists to make sayable, on the field it is
        // about. A clip's in-point and an input's `-ss` are both "start later"
        // and they are not the same decision: one picks a moment out of an
        // input, the other decides what the input is.
        row('Start at', number('srcss', 'ss', input.ss, '0',
            '-ss. An input seek is not a clip’s in-point: this moves the input’s zero, so ' +
            'it is what a clip is cut *from*. Trimming a clip picks a moment out of an ' +
            'input; this decides what the input is.')),
        row('Stop at', number('srcto', 'to', input.to, 'the end',
            '-to. Where the input stops, on its own clock.')),
        row('Delay by', number('srcoffset', 'itsoffset', input.itsoffset, '0',
            '-itsoffset. Shifts every timestamp, which is how a camera and a separately ' +
            'recorded soundtrack are lined up.')),
        // `-stream_loop` is the one thing here libavformat has never heard of:
        // ffmpeg's own CLI implements it by seeking the input back to the
        // start and shifting every timestamp forward, and so does this
        // binary's `InputLoop`. It belongs beside the window because it is the
        // other half of the same question — how much of this input there is.
        row('Repeat', number('srcloop', 'streamLoop', input.streamLoop, '0',
            '-stream_loop. How many more times to read this input after the first. -1 is ' +
            'forever, and forever has no length — so an input that loops is as long as ' +
            'Stop at says and no longer.', '× more')),
        len ? row('Length', el('span', {
            cls: 'mono', text: clock(len),
            title: endless(input) ? 'This input never ends — Stop at is what gives it a length'
                                  : 'What is left after the window',
        })) : null,
        // An input with no length is `blocked()`'s to refuse, in the bar under
        // this column — which is pinned, and says the same words. It was said
        // here as well, and two copies of one sentence in one glance is what
        // this rework was about.
    ].filter(Boolean);
}

/// The act, and where it cannot be performed the reason it cannot.
///
/// **`blocked()` mirrors `openInput()` in app.js exactly**, which is the rule
/// the Capture stage's record bar follows for the same reason: a button that is
/// alive and then refuses is a button that has told you nothing, and a button
/// that is dead for a reason the model does not hold is worse. Both sides refuse
/// a device on what it is, and then state the two ways an input can have no
/// length, in the same order.
function blocked(input) {
    // Still opening is not "will not open", and the difference is the whole
    // point of the asynchronous path: one is a fault and the other is a wait.
    if (opening(input))
        return waitingOn(input) === 'device' ? 'Still opening' : 'Still connecting';
    if (input.error || !input.probe) return 'Will not open';
    const p = input.probe;
    if (!p.video && !p.audio) return 'Nothing to play';
    // Before the length, and not as one of its answers: `Stop at` gives a device
    // a length, and a length was never the half that was missing. See the note
    // in `openInput()` and `deviceRows()` below.
    if (kindOf(input) === 'device') return 'A device cannot be cut';
    // A still on the same rule, and for the same reason it was moved: the
    // length test let one through. `image2` — the demuxer this application
    // forces for a picture — measures a still as one frame at the declared
    // rate, 0.04 s at 25 fps, so only a picture opened *bare* through
    // `png_pipe` measured zero. A still whose `-loop` had been cleared from the
    // option column was laid out as a forty-millisecond clip. See `openInput()`
    // in ui/app.js, which is the other end of this.
    if (kindOf(input) === 'still' && !endless(input)) return 'One picture, no time at all';
    if (lengthOf(input) <= 0)
        return endless(input) ? 'Never ends — set Stop at'
             : 'No length to cut';
    return '';
}

function footRows(input) {
    const used = hooks.clipsOf ? hooks.clipsOf(input) : [];
    const inGraph = graphReads().has(input.id);
    const why = blocked(input);
    return [
        el('button', {
            cls: 'src-go', 'data-f': 'srcuse', text: 'Use on the timeline',
            disabled: !!why,
            title: why || 'Cut a clip of the whole window and lay it on the timeline',
            on: { click: () => { if (hooks.use) hooks.use(input); } },
        }),
        why ? el('span', { cls: 'src-why', text: why, title: whyAt(input, why) }) : null,
        div('spacer'),
        ...localCopyButtons(input),
        el('button', {
            cls: 'tiny', 'data-f': 'srcreopen', text: 'Re-probe',
            title: 'Open it again with exactly what it says now',
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
    ];
}

/// Saving a stream to this machine, and using the file once it is here.
///
/// **Offered for a stream and not for a file**, which is the whole distinction:
/// a path on this machine is already local and a `Save a local copy` beside one
/// would be an offer to duplicate a file for no reason. What makes it worth
/// having is that everything downstream reads an input *repeatedly* — a scrub, a
/// filmstrip, a waveform, a transcription pass, a render — and for a URL every
/// one of those is a network read of a five-hour recording. `tools/montage.js`
/// transcribes each hit's window a second time to place the cut on what the
/// media itself said, and doing that over HLS is the same segments fetched
/// twice.
///
/// **The press starts it rather than walking to the Write stage.** It used to
/// fill the render in and take you there, on the argument that three quarters of
/// an hour of bandwidth is worth reading the invocation for first — which was
/// right about the cost and wrong about the answer. What it cost was the render:
/// the one job slot, held for the length of a download, so the application you
/// were pulling the recording into could not render anything until it finished.
/// A fetch is not a render (src/native/fetch_queue.h), so this queues two of them
/// and stays where it is. The range is still yours: a window is what
/// `Cut this out` on a hit takes, and the Write stage's own `Rewrap` is still
/// there for a copy you want to describe by hand.
function localCopyButtons(input) {
    if (!input.origin && !input.renditions) return [];
    const out = [];
    // Once a copy has been written, the offer changes to using it. Kept on the
    // input rather than guessed at from the filesystem, because "a file with
    // about the right name exists" is not the same claim as "this is the copy
    // this application wrote of this stream".
    if (input.localCopy)
        out.push(el('button', {
            cls: 'tiny', 'data-f': 'srclocaluse', text: 'Use the local copy',
            title: `Point this input at ${input.localCopy} — the clips cut from it keep ` +
                   'their times, which is right because it is a copy of these packets ' +
                   'and not another rendition',
            on: { click: () => {
                change(input, { path: input.localCopy });
                if (hooks.flash) hooks.flash(`Reading ${basename(input.localCopy)} locally now`);
            } },
        }));
    const job = copiesOf(input);
    const busy = job && ['audio', 'video'].some(
        (w) => job[w].state === 'waiting' || job[w].state === 'probing' ||
               job[w].state === 'queued' || job[w].state === 'running');
    out.push(el('button', {
        cls: 'tiny', 'data-f': 'srclocal',
        text: busy ? 'Pulling…' : (job ? 'Pull it again' : 'Save a local copy'),
        disabled: !input.probe || !!busy,
        title: input.probe
            ? 'Copy this stream to a file on this machine — the soundtrack first, ' +
              'because it is a few percent of the bytes and is what a word search needs, ' +
              'and the picture behind it. No decode and no encode, and nothing here waits.'
            : 'It has not opened yet',
        on: { click: () => { if (hooks.saveLocally) hooks.saveLocally(input); } },
    }));
    // **And the same copy, by hand.** The press above takes every decision — both
    // renditions, Matroska, a name beside the document, the whole recording — and
    // those are the right defaults and not the only answers. A section, another
    // container, a stream left out, or simply reading the invocation before it
    // runs are all the Write stage's, which is where this application describes
    // renders; this is the door to it, carrying the same rows the press would
    // have used.
    out.push(el('button', {
        cls: 'tiny', 'data-f': 'srclocalhand', text: 'Describe it…',
        disabled: !input.probe,
        title: 'Set the Write stage up to copy this stream, without starting anything — ' +
               'for a section, another container, or to read the command first',
        on: { click: () => { if (hooks.describeCopy) hooks.describeCopy(input); } },
    }));
    return out;
}

/// Where a copy of this stream goes, and where the two pulls have got to.
///
/// **The soundtrack's row is the one this whole ordering exists for**, so it
/// says what it unlocks the moment it lands rather than only that it is there:
/// the point of pulling the sound first is that the work which needs only sound
/// can start while the picture is still arriving, and a row that said `done` and
/// nothing else would leave that to be discovered.
///
/// The *pull* rows are drawn only once something has been asked for — an input
/// nobody has pressed the button on gets no pair of rows saying `—`. The folder
/// is the exception and is always here, because it is the one thing you want to
/// know before pressing rather than after.
function localCopySection(input) {
    // Drawn for anything that *could* be pulled rather than only for something
    // that has been, because the first question this feature was asked is where
    // the file went — and the moment to answer it is before fourteen gigabytes
    // are on their way somewhere, not after.
    if (!input.origin && !input.renditions) return [];
    return [head('On this machine', {
        title: 'Where a copy of this stream goes, what has been pulled already, ' +
               'and where each pull has got to',
    }), copyFolderRow(), ...localCopyRows(input)];
}

/// Where a copy will be written, said out loud, with the press that changes it.
///
/// **The folder and *why* it is that folder**, because the default has two
/// cases and only one of them is a place somebody can find: beside the
/// document is obvious once a document exists, and before that it is the
/// directory the application happens to have been started in, which is a real
/// answer and a useless one. So the row says which of the two is speaking, and
/// the press that ends the question is right there.
function copyFolderRow() {
    const dir = hooks.copiesGo ? hooks.copiesGo() : '.';
    const chosen = copyFolder();
    const why = chosen
        ? 'chosen — every copy goes here'
        : dir === '.'
        ? 'the folder this application was started in — save the document, or ' +
          'choose one'
        : 'beside the document';
    const nodes = [
        span(dir, 'mono'),
        span(why, 'dim'),
        el('button', {
            cls: 'tiny', 'data-f': 'srccopydir', text: 'Choose…',
            title: 'Pick the folder every local copy is written to. A five-hour ' +
                   'stream is tens of gigabytes, so this is usually a question ' +
                   'about which disk.',
            on: { click: () => {
                if (typeof showOpenFolderDialog !== 'function') return;
                const picked = showOpenFolderDialog(dir === '.' ? null : dir);
                if (!picked || !picked.length) return;   // cancelled, not cleared
                useCopyFolder(String(picked[0]));
                drawSources();
            } },
        }),
    ];
    if (chosen)
        nodes.push(el('button', {
            cls: 'tiny', 'data-f': 'srccopydirclear', text: 'Beside the document',
            title: 'Forget the chosen folder and put copies beside the document again',
            on: { click: () => { useCopyFolder(''); drawSources(); } },
        }));
    return row('Folder', nodes);
}

function localCopyRows(input) {
    const job = copiesOf(input);
    if (!job) return [];
    const rows = [];
    const line = (which, what) => {
        const pull = job[which];
        if (!pull.state) return;
        const word = PULL_WORDS[pull.state] || pull.state;
        const pct = pull.state === 'running'
            ? ` ${Math.round(pull.progress * 100)}%` : '';
        const size = pull.bytes ? ` · ${bytes(pull.bytes)}` : '';
        const stoppable = pull.state === 'waiting' || pull.state === 'probing' ||
                          pull.state === 'queued' || pull.state === 'running';
        rows.push(row(what, [
            span(`${word}${pct}${size}`, 'mono' + (pull.state === 'failed' ? ' warn' : '')),
            // What it is called, since the folder is a row above and the two
            // together are the whole answer to "where did it go". The name
            // rather than the path: the path is on the row above and repeating
            // it twice per pull is how a card stops being read.
            pull.path ? el('span', { cls: 'dim', text: basename(pull.path),
                                     title: pull.path }) : null,
            stoppable ? el('button', {
                cls: 'tiny', 'data-f': `srcstop-${which}`, text: 'Stop',
                title: 'Stop this pull. What has been written stays where it is.',
                on: { click: () => { cancelCopy(input, which); drawSources(); } },
            }) : null,
            pull.error ? note(pull.error) : null,
        ]));
    };
    line('audio', 'Sound');
    line('video', 'Picture');
    if (job.audio.state === 'done')
        rows.push(note('The soundtrack is on this machine. A word search reads it now — ' +
                       'the picture can go on arriving.'));
    // The fact a cut has to be told, said where the pair is made rather than
    // left for whoever makes one. See ui/localcopy.js.
    if (!job.sameClock && job.audio.state === 'done')
        rows.push(note('These are two renditions of one recording and they do not share a ' +
                       'zero — measured at +0.80 s, +2.21 s and +2.57 s on one pair. So a ' +
                       'time found in the sound is where to look in the picture and not ' +
                       'where to cut it.'));
    return rows;
}

/// What to do about it, for the things `blocked()` can say.
function whyAt(input, why) {
    if (why === 'Still connecting')
        return 'The open is running on a thread of its own. It will give up by itself if ' +
               'nothing answers, and Stop above abandons it now.';
    if (why === 'Still opening')
        return 'The device is being opened on a thread of its own, so nothing here is ' +
               'blocked. Stop waiting above gives up on it; it cannot abort the driver.';
    if (why === 'Will not open') return input.error || 'Nothing came back from the probe';
    if (why === 'Nothing to play')
        return 'No picture to lay out and no sound to mix. A file of cues travels as a ' +
               'stream on the Write stage, or is burned in by a filter on the Graph stage.';
    if (why === 'A device has no end')
        return 'A clip is an in-point and a length, and a live input has neither. Record it ' +
               'on the Capture stage, and the recording is a file.';
    if (why === 'One picture, no time at all')
        return 'A picture has no length of its own — Still above is where it is given one, ' +
               'and -loop 1 with a -t is what that writes. Neither half alone is a clip: the ' +
               'loop with no -t never ends, and a -t with no loop is a window on one frame.';
    if (why === 'No length to cut')
        return 'Nothing in this input says how long it is, so there is no window for a clip ' +
               'to be cut from. Stop at says where to stop reading.';
    return why;
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
            // No prose above the search box, for the reason the Capture stage's
            // column has none: what it said is what the empty-search line
            // already says, and three of these columns stacked was a screen of
            // paragraphs with the tables underneath them.
            options: all,
            bag: input.options,
            hint: 'An unknown key stops the open rather than being ignored.',
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
            options: all,
            bag: input.decoderOptions,
            hint: 'These reach playback and the render alike.',
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
                options: all,
                bag: input.options,
                hint: 'Timeouts, certificates, buffer sizes.',
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
    // Nothing has come back yet, and saying "no streams" would be describing a
    // file nobody has read. The Opening rows above are what this input has to
    // say about itself right now.
    if (opening(input)) return [];
    if (input.error)
        return [
            head('Refused', {
                title: 'The demuxer, the options and the window above are what this input ' +
                       'is opened with. Change one and it is tried again.',
            }),
            div('src-error', input.error),
        ];
    if (!input.probe) return [];
    return fileRows(input.probe, input);
}

/// What came back, in as many lines as there are streams plus one.
///
/// It was six rows a stream and six for the container — forty rows for an
/// ordinary camera file with two soundtracks, and the readout most often looked
/// at on this stage was the one you had to scroll for. Nothing is dropped: what
/// is not on the line is on the line's tooltip, which is where a pixel aspect
/// ratio of 1.0000 belongs.
function fileRows(p, input) {
    return [
        head('What came back', { title: 'Probed with the options above in force, so this ' +
                                        'is the file as this input opens it' }),
        div('src-file', [
            el('span', { cls: 'mono src-file-name', text: p.format.name,
                         title: p.format.longName || p.format.name }),
            // Each fact only where there is one. A device reports no duration
            // and no size, and `00:00:00 · —` beside a screen grabber reads as
            // a broken file rather than as a live input.
            span([p.format.duration ? clock(p.format.duration) : '',
                  p.format.size ? bytes(p.format.size) : '',
                  p.format.bitRate ? kbps(p.format.bitRate) : ''].filter(Boolean).join(' · '),
                 'dim'),
        ]),
        // **Stream lines and nothing else.** Two readers used to hang off
        // these — the telemetry parser under a data line, and the sound marks
        // under the first audio line — each defensible on its own and wrong together. A probe answer
        // is what libavformat said the moment this input was opened; a read is
        // minutes of this machine, spent on purpose. Mixing
        // them cut the one readout on this stage that is looked at most in half. They are
        // `readRows` now, in a section that says what they are.
        ...p.streams.map(streamLine),
    ];
}

// ── what has been read out of it ───────────────────────────────────────────

/// Every deep read of this input, in one section, in one vocabulary.
///
/// **A read is not what came back, and this section exists to stop the two
/// being the same paragraph.** These two — what a data track carries and where
/// something happens in the soundtrack — were each drawn
/// *inside* the stream list, under the line of the stream they read. One at a
/// time that is defensible and each of them argued it in its own header: the
/// control that dispatches on a fourcc belongs beside the fourcc, the control
/// that reads a soundtrack belongs beside the soundtrack. In aggregate it was
/// wrong. A probe answer is what libavformat said the instant this input was
/// opened, free and complete; a read is spent because somebody pressed a button.
/// Drawing them as one thing cut the readout looked at more than anything else on this stage — what is in
/// this file — in half.
///
/// So `What came back` is the probe and this is what has been spent on it.
///
/// **Each row names its stream**, which the old rows did not and could not.
/// Marks are read from `av_find_best_stream`'s pick and were drawn
/// under the *first* audio line, so the position asserted an answer neither
/// reader had given. It reports the index it was actually handed
/// (`sound_marks.h`), and `soundStream` says it.
///
/// **The presses stay on this stage.** A set of marks belongs to
/// an *input*, and they cost time, so nothing should start one unasked.
function readRows(input) {
    if (!input || !input.probe) return [];
    const rows = [
        ...telemetryRows(input),
    ];
    if (!rows.length) return [];
    return [
        head('Reading it', {
            title: 'What this machine has been asked to work out about this input, ' +
                   'beyond opening it. Nothing here happens on its own: each is a ' +
                   'press, because each costs real time, and each answer is derived ' +
                   'rather than part of the edit — none of it is in the document, on ' +
                   'the undo track or in the unsaved marker.',
        }),
        ...rows,
    ];
}

/// One read, on one line: what it reads, which stream it reads, where it has got
/// to, and the door.
///
/// Four columns and always the same four, which is the whole point of collecting
/// them: three readers that answer completely different questions are compared
/// at a glance by "has this been done, on what, and how did it go". `said` is a
/// node rather than a string because a failure is `src-error` and a summary is
/// `dim`, and the difference between those is the row's answer.
function readLine(what, of, ofWhy, said, acts) {
    return div('src-read', [
        span(what, 'src-read-k'),
        el('span', { cls: 'src-read-of mono', text: of, title: ofWhy || '' }),
        typeof said === 'string' ? el('span', { cls: 'src-read-v dim', text: said }) : said,
        ...(acts || []).filter(Boolean),
    ]);
}

/// A second line under a read, for whatever it has to offer once it is done —
/// the mark chips, the series chips, a refusal count. Indented under the row it
/// belongs to rather than beside it, because there can be forty of them.
function readUnder(kids) { return div('src-read-more', kids.filter(Boolean)); }

function transcriptRows(input, r) {
    const part = (r.duration > 0 && r.read < r.duration - 0.5);
    return [line(`${r.segments.length} segment${r.segments.length === 1 ? '' : 's'}` +
                 (part ? ` · only the first ${clock(r.read)} of ${clock(r.duration)}`
                       : ' · all of it'), [
        part ? el('button', { cls: 'btn tiny', text: 'Carry on',
                              title: 'Read the rest of the soundtrack.',
                              on: { click: () => {
                                  transcriptModel.dropTranscript(input.id);
                                  transcriptModel.transcribe(input);
                                  drawSources(); } } })
             : null,
        el('button', { cls: 'btn tiny', text: 'Forget',
                       title: 'Drop this transcript.',
                       on: { click: () => { transcriptModel.dropTranscript(input.id);
                                            drawSources(); } } }),
        modelButton(),
    ])];
}

/// What a data track carries, for the ones something here can read.
///
/// Offered **only** where a parser exists: `streamsWorthReading` filters against
/// `bro.ffmpeg.data.parsers()`, which is asked of the native registry. A real
/// GoPro file carries `gpmd`, `tmcd` and `fdsc`, and two of those get no row
/// rather than a button that fails at the press.
///
/// One row per readable track rather than one for the input, unlike the two
/// above: a file can carry two of these and they are genuinely two reads, which
/// is why the fourcc is in the row's stream column. Every data stream probes as
/// `bin_data`, so without the tag a file with two would show the same row twice
/// — the same fact `streamLine` states, and the reason the tag is on that line.
function telemetryRows(input) {
    const rows = [];
    for (const stream of streamsWorthReading(input)) {
        const of = `D${stream.index}`;
        const why = `${stream.tag || stream.codec} — parsed by the reader registered ` +
                    'for that fourcc, which is the whole identity of a data track ' +
                    '(every one of them probes as bin_data).';
        const e = readingOf(input.id, stream.index);

        if (!e) {
            rows.push(readLine('Telemetry', of, why, 'nothing has read this track yet', [
                el('button', { cls: 'btn tiny', text: 'Read it',
                               title: 'Parse this track and offer what it carries. It is a ' +
                                      'walk over the whole track -- 32 ms for a four-hour-' +
                                      'gigabyte camera file -- and it happens on a thread, ' +
                                      'so nothing here stops while it does.',
                               on: { click: () => { readStream(input, stream.index);
                                                    drawSources(); } } }),
            ]));
            continue;
        }
        if (e.state === 'reading') {
            rows.push(readLine('Telemetry', of, why, 'Reading' + (e.elapsed > 0.4
                ? ' · ' + e.elapsed.toFixed(1) + 's' : '') + '…', []));
            continue;
        }
        if (e.state !== 'done') {
            rows.push(readLine('Telemetry', of, why,
                               span(e.error || 'will not read', 'src-read-v src-error'), [
                el('button', { cls: 'btn tiny', text: 'Again',
                               on: { click: () => { dropReading(input.id, stream.index);
                                                    readStream(input, stream.index);
                                                    drawSources(); } } }),
            ]));
            continue;
        }

        const r = e.reading;
        const facts = [r.device, r.series.length + ' series', r.packets + ' packets']
            .filter(Boolean).join(' · ');
        rows.push(readLine('Telemetry', of, why, facts, [
            el('button', { cls: 'btn tiny', text: 'Forget',
                           title: 'Drop this reading and take its series off the timeline.',
                           on: { click: () => { dropReading(input.id, stream.index);
                                                drawSources(); } } }),
        ]));
        // A track that would not parse all the way through is drawn with what
        // survived and **says so**, because an empty plot cannot be told from a
        // file with nothing in it. The count is the honest measure: one bad
        // packet in seven thousand is a scratch, and seven thousand is a
        // different file.
        if (r.refused > 0)
            rows.push(readUnder([
                span(r.refused + ' of ' + r.packets + ' packets would not parse · ' +
                     r.refusal, 'src-error'),
            ]));
        rows.push(readUnder(r.series.map((sv) => seriesChip(input, stream.index, sv))));
    }
    return rows;
}


/// One series, as a thing to put on the timeline or take off it.
///
/// The label is the fourcc first and the file's own `STNM` after it, which is
/// `labelOf`'s rule and is stated there. What is on the chip beside it is the
/// **reach** -- the exact min and max over every sample, not over the buckets --
/// and the unit the file gave, because "is this the one I want" is a question
/// about the numbers and not about the name.
///
/// A series the format's own divisor could not be applied to is marked `raw`.
/// That is the one thing on this stage that says a number may not mean what it
/// looks like, and it is worth a word: an unscaled `GPS5` latitude is
/// 474305352, which is a number, and 47.4305352 is a place.
function seriesChip(input, streamIndex, sv) {
    const on = isPicked(input.id, streamIndex, sv);
    const reach = shortNum(sv.min) + '..' + shortNum(sv.max) + (sv.units ? ' ' + sv.units : '');
    return el('button', {
        cls: 'src-series' + (on ? ' on' : ''),
        title: labelOf(sv) + '\n' + sv.samples + ' samples at ' +
               sv.rate.toFixed(1) + ' Hz\n' + reach +
               (sv.scaled ? '' : '\nno divisor was applied to this one'),
        on: { click: () => {
            const why = pick(input.id, streamIndex, sv);
            if (why && hooks.flash) hooks.flash(why);
            drawSources();
        } },
    }, [
        span(labelOf(sv), 'mono'),
        span(reach + (sv.scaled ? '' : ' raw'), 'dim'),
    ]);
}

/// Enough of a number to tell two series apart on a chip.
function shortNum(v) {
    if (!Number.isFinite(v)) return '--';
    const a = Math.abs(v);
    if (a >= 10000) return v.toExponential(1);
    if (a >= 100) return String(Math.round(v));
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
}

/// One stream, on one line, in the terms that stream is described in.
///
/// Kept verbatim from `probe()`: "untagged" and "bt601" are different facts,
/// and this is the screen where the difference is the point — which is why the
/// colour tag is on the line itself and the pixel format beside it, while the
/// profile and the language are in the tooltip.
function streamLine(s) {
    const kind = s.kind === 'video' ? 'V' : s.kind === 'audio' ? 'A'
               : s.kind === 'data' ? 'D' : 'S';
    const bits = [];
    const more = [s.codecLong || s.codec];
    // **On the line for a data stream and in the tooltip for the others**,
    // which is this readout's own rule about where a fact goes. A telemetry
    // track has nothing else to say — no size, no rate, no layout — and every
    // one of them is called `bin_data`, so without the fourcc a file with two
    // shows the same line twice. For a picture it is supporting detail that
    // matters in one argument only: an mp4 tagged `hvc1` plays on an Apple
    // device and the same HEVC tagged `hev1` does not.
    if (s.tag) (s.kind === 'data' ? bits : more).push(s.tag);
    if (s.kind === 'video') {
        bits.push(`${s.width}×${s.height}` +
                  (s.rotation ? ` → ${s.displayWidth}×${s.displayHeight}` : ''));
        if (s.fps) bits.push(`${s.fps.toFixed(2)} fps`);
        if (s.pixFmt) bits.push(s.pixFmt);
        // What the render has to convert out of, and the reason the filtergraph
        // can be written faithfully at all — worth 13 dB, and invisible
        // everywhere else in the application.
        if (s.colorSpace || s.colorRange) {
            bits.push(s.colorSpace || 'untagged');
            more.push(`colour ${s.colorSpace || 'untagged'} · ` +
                      `${s.colorRange || 'range untagged'}`);
        }
        if (s.rotation) more.push(`rotated ${s.rotation}°`);
        if (s.sampleAspect && Math.abs(s.sampleAspect - 1) > 0.001)
            more.push(`pixel aspect ${s.sampleAspect.toFixed(4)}`);
    } else if (s.kind === 'audio') {
        bits.push(`${s.sampleRate} Hz`);
        bits.push(s.channelLayout || `${s.channels} ch`);
        if (s.sampleFmt) more.push(`samples ${s.sampleFmt}`);
    }
    if (s.bitRate) bits.push(kbps(s.bitRate));
    if (s.profile) more.push(`profile ${s.profile}`);
    if (s.language) more.push(s.language);
    if (s.title) more.push(s.title);
    if (s.duration) more.push(`${s.duration.toFixed(3)} s`);

    return el('div', { cls: 'src-stream', title: more.join('\n') }, [
        span(`${kind}${s.index}`, 'src-stream-n'),
        span(s.codec, 'mono'),
        span(bits.join(' · '), 'src-stream-what dim'),
    ]);
}
