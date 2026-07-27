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

import { div, span, el, put, row, head, fromTemplate, show } from './dom.js';
import { clock, bytes, kbps } from './format.js';
import { inputs, addInput, updateInput, reprobe, removeInput, summary, schemeOf,
         lengthOf } from './inputs.js';
import { optionColumn } from './opttable.js';

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
            const input = addInput({ path });
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
}

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

function drawList() {
    const current = chosen();
    put(refs.list, () => {
        if (!inputs.length)
            return div('dim pad', 'No inputs. Add a path or a URL above, or drop a file ' +
                                  'on the timeline.');
        return inputs.map((input) => {
            const node = fromTemplate('tpl-input');
            const used = hooks.clipsOf ? hooks.clipsOf(input).length : 0;
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
            node.querySelector('.src-used').textContent =
                input.error ? 'unreadable'
                            : used ? `${used} clip${used === 1 ? '' : 's'}` : 'unused';
            node.addEventListener('click', () => {
                chosenId = input.id;
                demuxerOpen = false;
                drawSources();
            });
            return node;
        });
    });
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

/// The window: which part of the input there is.
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
        len ? row('Length', span(`${clock(len)} of input`, 'mono')) : null,
    ].filter(Boolean);
}

function actionRows(input) {
    const used = hooks.clipsOf ? hooks.clipsOf(input) : [];
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
            text: used.length ? `In use by ${used.length}` : 'Remove',
            disabled: used.length > 0,
            title: used.length
                ? 'Delete the clips cut from it first — a clip with no input has nothing to decode'
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
