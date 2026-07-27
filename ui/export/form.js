// The settings column, and the column of everything else.
//
// The form is drawn from what the encoder reports, so it changes shape per
// codec: x264 gets a CRF slider from 0 to 51 and ten presets, VP9's goes to
// 63, ProRes gets its six profiles and no quality slider at all. Nothing here
// decides what an encoder is like — capabilities.js asks libavcodec and this
// draws the answer.
//
// Every control carries its own listener, made at the same moment the control
// is. There is no second pass that finds elements again by id and attaches
// behaviour to them: that pass could always be one control behind the markup,
// and was — a segment that moved to the advanced column quietly stopped doing
// anything, because the code that wired it looked only in the left one.

import { project } from '../project.js';
import { el, div, span, put, select, segmented, show,
         row, head } from '../dom.js';
import { basename } from '../format.js';
import { btns, num, note } from './controls.js';
import { settings, activeVideoCodec, activeAudioCodec, outputExt,
         outputFps } from './state.js';
import { videoEncoders, audioEncoders, muxers, encoderInfo, audioInfo,
         muxerInfo, optionsOf, formatOptionsOf,
         rateModes, qualityRange } from './capabilities.js';
import { defaultPath, withExtension, withPattern, withoutPattern,
         range } from './spec.js';
import { cutPoints } from './options.js';
import { isHardwareEncoder, deviceOfEncoder, encodeCost } from '../hardware.js';
import { optionColumn } from '../opttable.js';
import { setAudioIncluded } from './streams.js';
import { kindOf, describeKind, schemeOf, protocolLinked, teeSpec,
         newDestination } from './destination.js';

let panes = {};
let hooks = {};

let showAdvanced = false;

// The muxer picker's own state. Held here rather than in `settings` because
// none of it is part of the render: which facet you were looking at and what
// you had typed are where you are, not what will be written.
let formatOpen = false;
let formatSearch = '';
let formatFacet = 'fits';
let showFormatOptions = false;

// Held between draws so the parts that update on their own — the quality
// readout as the slider moves, the filename beside "Choose…" — can be written
// without rebuilding the form under the pointer.
let qualityLabel = null;
let fileLabel = null;

export function initForm(refs, h) {
    panes = refs;
    hooks = h || {};
}

const RATE_LABELS = {
    quality: 'Quality', bitrate: 'Bitrate', twopass: 'Two-pass',
    constrained: 'Capped', lossless: 'Lossless',
};
const RATE_HINTS = {
    quality: 'Constant quality: the bitrate lands wherever it needs to',
    bitrate: 'A target the encoder averages out to',
    twopass: 'The same target, measured first and then spent where it is needed',
    constrained: 'An average with a ceiling, for streaming',
    lossless: 'Nothing thrown away',
};

export function drawForm() {
    const codec = activeVideoCodec();
    const info = encoderInfo(codec) || { presets: [], tunes: [], profiles: [], pixelFormats: [] };
    const cont = muxerInfo(settings.container) || { videoCodecs: [], audioCodecs: [] };

    // Where it goes belongs to the Write stage, not to this one. Encode is
    // about what the picture is put through, and a filename at the top of that
    // column was the first thing asked for and the last thing decided.
    put(panes.dest, () => [head('Destination'), ...outputRows()]);

    // The muxer's own option table, in a column of its own, for the same reason
    // the encoder's is: `hls` has thirty options and `matroska` twenty, and a
    // fold under the format picker is not somewhere anybody reads thirty rows.
    if (panes.format) {
        show(panes.format, showFormatOptions);
        put(panes.format, () => (showFormatOptions ? formatOptionRows() : []));
    }

    put(panes.settings, () => [
        head('Video'),
        ...videoRows(codec, info, cont),
        head('Audio'),
        ...audioRows(cont),
        head(`${showAdvanced ? '▾' : '▸'} Advanced`, {
            'data-f': 'advanced',
            cls: 'section-head ex-toggle',
            on: { click: () => { showAdvanced = !showAdvanced; drawForm(); } },
        }),
    ]);

    // The advanced block is a column of its own rather than a fold at the
    // bottom of this one. There are eighty options for x265; reading them
    // through a slot under twenty other controls is not reading them, and
    // scrolling away from the codec to reach them is worse.
    show(panes.advanced, showAdvanced);
    put(panes.advanced, () => (showAdvanced ? advancedRows(codec) : []));
}

// ── output ─────────────────────────────────────────────────────────────────

/// Where the render goes — a file, a set of files, a URL, or several at once.
///
/// **The panel states what the destination is before it offers anything.** The
/// four shapes want different things said about them: a set of files wants to
/// know what the pieces will be called, a URL wants to know whether this build
/// can reach its protocol at all, and a tee wants the list. None of that is a
/// mode somebody picks — see ui/export/destination.js, where the shape is asked
/// of the muxer and the path rather than declared.
function outputRows() {
    const muxer = muxerInfo(settings.container) || { name: settings.container };
    const kind = kindOf(muxer);
    const all = formatOptionsOf(settings.container);

    const rows = [
        row('Goes to', span(KIND_LABELS[kind], 'mono')),
        row('', note(describeKind(kind, muxer))),
    ];

    if (kind === 'several') rows.push(...teeRows());
    else rows.push(...oneTargetRows(kind));

    rows.push(...formatRows());
    rows.push(head(`${showFormatOptions ? '▾' : '▸'} ${settings.container} options · ${all.length}`, {
        'data-f': 'formatopts',
        cls: 'section-head ex-toggle',
        on: { click: () => { showFormatOptions = !showFormatOptions; drawForm(); } },
    }));
    return rows;
}

const KIND_LABELS = {
    file: 'one file',
    files: 'a set of files',
    stream: 'a stream',
    several: 'several destinations',
};

/// The ordinary case, and the two that are nearly it: a path, or a URL.
function oneTargetRows(kind) {
    const path = el('input', {
        cls: 'wide', 'data-f': 'path', type: 'text', value: settings.path,
        on: { change: () => {
            settings.path = path.value.trim();
            followExtension();
            refreshFileLabel();
            hooks.tweaked();
        } },
    });

    fileLabel = span('', 'dim mono');
    fileLabel.classList.add('ex-dir');
    refreshFileLabel();

    const rows = [row(kind === 'stream' ? 'URL' : 'File', path)];

    const scheme = schemeOf(settings.path);
    if (scheme) {
        // A URL naming a protocol that is not in this build fails at open with
        // a message about a filename, which is the least useful place to find
        // out. The same row the Sources stage draws for an input, for the same
        // reason and out of the same list.
        const linked = protocolLinked(scheme);
        rows.push(row('Protocol', span(
            linked ? `${scheme} · linked in` : `${scheme} · not in this build`,
            linked ? 'mono' : 'mono src-missing')));
        rows.push(row('', note(
            'Its own options are in the column beside the muxer’s. They travel in one bag, ' +
            'which is what libavformat does with what a muxer does not recognise — and a ' +
            'key neither takes stops the render rather than being ignored.')));
    } else {
        // Only where there is a file to choose. A dialog for a URL would be a
        // dialog that cannot say what is being asked for.
        rows.push(row('', btns([
            el('button', { cls: 'tiny', 'data-f': 'browse', text: 'Choose…',
                           on: { click: () => browse(path) } }),
            fileLabel,
        ])));
    }

    rows.push(...numberingRows(path));
    return rows;
}

// ── several destinations ───────────────────────────────────────────────────
//
// One encode, several places. The list is edited as a list — each row a muxer,
// a target and its own options — and the `-f tee` argument is *built* from it
// rather than typed, because that argument is a small language with two layers
// of escaping over it and hand-writing one correctly is a party trick.
//
// It is shown as well as built, in full, under the list: the whole claim of
// this application is that nothing reaches ffmpeg unseen, and an argument
// assembled on your behalf is exactly the thing that has to be visible.

function teeRows() {
    const list = settings.destinations;
    const rows = [];

    list.forEach((d, i) => {
        const target = el('input', {
            cls: 'wide', 'data-f': `tee-path-${i}`, type: 'text', value: d.path,
            on: { change: () => { d.path = target.value.trim(); hooks.changed(); } },
        });
        const muxer = el('input', {
            cls: 'wide', 'data-f': `tee-format-${i}`, type: 'text', value: d.format,
            placeholder: 'muxer, by name — mpegts, flv, matroska',
            on: { change: () => { d.format = muxer.value.trim(); hooks.changed(); } },
        });
        const scheme = schemeOf(d.path);
        rows.push(head(`Destination ${i + 1}`, {
            cls: 'section-head',
        }));
        rows.push(row('-f', muxer));
        rows.push(row('To', target));
        if (scheme)
            rows.push(row('', note(protocolLinked(scheme)
                ? `${scheme} · linked in`
                : `${scheme} · not in this build, so this destination will fail at open`)));
        rows.push(row('', btns([
            el('button', { cls: 'tiny', 'data-f': `tee-drop-${i}`, text: 'Remove',
                           on: { click: () => {
                               settings.destinations.splice(i, 1);
                               hooks.changed();
                           } } }),
        ])));
    });

    rows.push(row('', btns([
        el('button', { cls: 'tiny', 'data-f': 'tee-add', text: '+ Destination',
                       on: { click: () => {
                           // The muxer the Encode stage is set to is the
                           // sensible first answer for the first destination
                           // and a poor one for the second, which is usually
                           // the whole reason there is a second.
                           settings.destinations.push(newDestination({
                               format: list.length ? '' : 'matroska',
                               path: '',
                           }));
                           hooks.changed();
                       } } }),
    ])));

    const spec = teeSpec();
    rows.push(row('-f tee', span(spec || 'nothing to write yet', spec ? 'mono ex-tee' : 'dim')));
    rows.push(row('', note(
        'Built rather than typed: tee separates its destinations with | and reads each ' +
        'one’s options out of [ ], so a | or a \\ in a target and a : or a ] in an option ' +
        'value have to be escaped — and then the shell quotes the lot again, which is a ' +
        'second and separate layer. The command bar prints what runs.')));
    return rows;
}

// ── writing a run of files ─────────────────────────────────────────────────
//
// `image2` is the one muxer whose output is not a file but a *set* of them,
// and the only thing that says which is which is the filename: `out%04d.png`
// is three hundred pictures and `out.png` is one picture written three hundred
// times over itself. That is the whole reason these rows exist rather than
// `update` and `start_number` being left in the option column where they
// technically live.
//
// **What is shown is what will be on disk, not the pattern that produces it.**
// `%04d` is exactly the kind of thing somebody gets wrong once and then never
// trusts again, and the names come from `av_get_frame_filename2` — the same
// function the muxer calls — so this is the answer rather than a second
// implementation of it.

/// The encoder follows the filename, for the one muxer where the filename
/// names a codec.
///
/// **`image2` is the exception to how every other extension in libavformat
/// works.** `.png` is PNG data and `.bmp` is BMP data through the same muxer,
/// so the extension is a codec and not a container — which is why `ffmpeg`
/// resolves it with `av_guess_codec` and why leaving the encoder on the
/// muxer's declared default lands every image render on mjpeg whatever the
/// file is called. Only for image2: everywhere else the extension is the
/// container and the encoder is a decision of its own.
function followExtension() {
    if (settings.container !== 'image2' || !settings.path) return;
    const guess = bro.ffmpeg.guessCodec('image2', settings.path);
    if (guess && guess !== settings.videoCodec) settings.videoCodec = guess;
}

/// How many frames this render will write, which is what the preview counts.
function outputFrames() {
    const r = range();
    const fps = outputFps();
    return Math.max(0, Math.round(r.length * fps));
}

function startNumber() {
    const n = Number(settings.extraFormat.start_number);
    return Number.isFinite(n) && n >= 0 ? n : 1;
}

function numberingRows(pathInput) {
    // Only image2. Every other muxer writes one file, and offering to number
    // it would be offering something the muxer has no idea about.
    if (settings.container !== 'image2') return [];

    const numbered = bro.ffmpeg.hasFramePattern(settings.path);
    const setPath = (next) => {
        settings.path = next;
        pathInput.value = next;
        refreshFileLabel();
        hooks.changed();
    };

    const rows = [
        head('Numbering'),
        row('Writes', segmented('ex-imgmode', [
            { v: 'seq', l: 'A file per frame', title: 'out%04d.png — a run of pictures' },
            { v: 'one', l: 'One picture', title: '-update 1 — the same file, rewritten' },
        ], numbered ? 'seq' : 'one', (v) => {
            if (v === 'seq') {
                delete settings.extraFormat.update;
                setPath(withPattern(settings.path));
                followExtension();
            } else {
                // `-update 1` is not optional for a single file: without it
                // image2 says the name has no pattern in it and every frame
                // after the first lands on top of the one before.
                settings.extraFormat.update = '1';
                setPath(withoutPattern(settings.path));
            }
        })),
    ];

    if (!numbered) {
        rows.push(row('', span(
            'One picture, rewritten on every frame of the range — so what is left is the ' +
            'last frame. Set the range to a single frame for the picture at the playhead.',
            'dim')));
        return rows;
    }

    const start = startNumber();
    const startField = el('input', {
        cls: 'num', 'data-f': 'startnumber', type: 'text',
        value: settings.extraFormat.start_number !== undefined
                   ? String(settings.extraFormat.start_number) : '',
        placeholder: '1',
        on: { change: () => {
            const v = startField.value.trim();
            if (v) settings.extraFormat.start_number = v;
            else delete settings.extraFormat.start_number;
            hooks.changed();
        } },
    });
    rows.push(row('-start_number', startField));

    const total = outputFrames();
    let names = [];
    try {
        names = bro.ffmpeg.frameNames(settings.path, start, Math.min(total || 1, 3));
    } catch (e) { names = []; }
    if (names.length) {
        const last = total > names.length
            ? bro.ffmpeg.frameNames(settings.path, start + total - 1, 1)[0] : '';
        rows.push(row('Files', div('ex-filenames', [
            ...names.map((n) => div('mono dim', basename(n))),
            total > names.length + 1 ? div('dim', '…') : null,
            last ? div('mono dim', basename(last)) : null,
        ].filter(Boolean))));
        rows.push(row('', span(
            `${total} file${total === 1 ? '' : 's'} over ${range().length.toFixed(2)} s at ` +
            `${outputFps().toFixed(3)} fps`, 'dim')));
    }
    return rows;
}

function browse(pathInput) {
    // Only ever from a click. These dialogs block the JS thread until they
    // are dismissed, so anything automatic — a headless run included — would
    // hang with no window to dismiss it at.
    if (typeof showSaveFileDialog !== 'function') return;
    const ext = outputExt();
    const chosen = showSaveFileDialog(`${ext.toUpperCase()}|${ext}`, settings.path || defaultPath());
    if (!chosen) return;
    settings.path = chosen;
    pathInput.value = chosen;
    refreshFileLabel();
    hooks.tweaked();
}

function refreshFileLabel() {
    if (fileLabel) fileLabel.textContent = settings.path ? basename(settings.path) : 'no file chosen';
}

// ── the muxer ──────────────────────────────────────────────────────────────
//
// A hundred and eighty of them, which is a genuine design problem and not one
// to be solved by writing down the good ones — that is precisely the table this
// replaced. So the picker is the filter palette's shape, because it is the same
// problem one stage later: a statement of what is chosen, a search over name
// and long name, and groups that come out of *asking each muxer something*.
//
// The four facets below are four queries. "Fits" is `avformat_query_codec`
// against the codecs the Encode stage is set to, which is the only grouping
// that matters most of the time — it is the difference between the muxers that
// will take this render and the ones that will refuse it at write_header.
// "Pictures" is an intra-only video codec and no audio codec. "Streaming" is
// AVFMT_NOFILE. "Devices" is libavdevice's own list. None of them is a
// judgement about which muxers are worth having.

const FACETS = [
    { id: 'fits',   label: 'Fits',      hint: 'Will hold the codecs this render is set to' },
    { id: 'files',  label: 'Files',     hint: 'Writes a file, and has an extension for it' },
    { id: 'stills', label: 'Pictures',  hint: 'Writes pictures and no sound' },
    { id: 'stream', label: 'Streaming', hint: 'Writes through a protocol rather than a file' },
    { id: 'device', label: 'Devices',   hint: 'A screen, a window, a sound card' },
    { id: 'all',    label: 'All',       hint: 'Every muxer this build links' },
];

/// Will this muxer hold what the render is currently set to encode? Both
/// halves, because a container that takes the picture and refuses the sound is
/// still a container this render cannot use.
function fits(m) {
    const v = activeVideoCodec();
    const a = activeAudioCodec();
    const wantsVideo = settings.streams.some((s) => s.kind === 'video');
    const wantsAudio = settings.audio && settings.streams.some((s) => s.kind === 'audio');
    if (wantsVideo && (!v || m.videoCodecs.indexOf(v) < 0)) return false;
    if (wantsAudio && (!a || m.audioCodecs.indexOf(a) < 0)) return false;
    return true;
}

function inFacet(m, facet) {
    switch (facet) {
        case 'fits':   return fits(m) && !m.device;
        case 'files':  return !!m.extensions.length && !m.noFile && !m.device;
        case 'stills': return m.stills;
        case 'stream': return m.noFile && !m.device;
        case 'device': return m.device;
        default:       return true;
    }
}

function formatRows() {
    const m = muxerInfo(settings.container) || { name: settings.container, label: '', extensions: [] };
    const stated = div('ex-fmt-current', [
        span(m.name, 'mono'),
        span(m.longName || '', 'dim'),
        el('button', {
            cls: 'tiny', 'data-f': 'container-open', text: formatOpen ? 'Close' : 'Change',
            on: { click: () => { formatOpen = !formatOpen; formatSearch = ''; drawForm(); } },
        }),
    ]);

    const rows = [row('Format', stated), row('', note(describeMuxer(m)))];
    if (formatOpen) rows.push(formatPicker());
    return rows;
}

/// What the muxer is, in the terms that decide whether it is the right one:
/// what the file will be called, and whether it will take this render.
function describeMuxer(m) {
    const bits = [];
    bits.push(m.ext ? `.${m.ext}` : 'no file extension of its own');
    if (m.device) bits.push('a device');
    else if (m.noFile) bits.push('writes through a protocol');
    if (m.stills) bits.push('pictures only');
    // A muxer that has not been taught to answer `avformat_query_codec` is a
    // third case and worth saying out loud: nothing here is filtering its
    // codec list, and it will refuse at write_header if it cannot take one.
    if (!m.answersCodecs) bits.push('does not say which codecs it takes');
    else if (!m.videoCodecs.length) bits.push('no video encoder here fits it');
    else if (!m.audioCodecs.length) bits.push('no audio encoder here fits it');
    else if (!fits(m)) bits.push('will not hold what this render is set to');
    return bits.join(' · ');
}

const MUXER_LIMIT = 40;

function formatPicker() {
    const list = div('ex-fmt-list');
    const field = el('input', {
        cls: 'wide', 'data-f': 'fmtsearch', type: 'text', value: formatSearch,
        placeholder: 'name, description or extension',
        on: { input: () => {
            formatSearch = field.value;
            // Only the list is rebuilt, so the field being typed into keeps
            // its caret — the same reason the option searches do it.
            put(list, () => muxerRows(list));
        } },
    });
    put(list, () => muxerRows(list));

    return div('ex-fmt-picker', [
        div('ex-fmt-facets', FACETS.map((f) => el('button', {
            cls: 'tiny' + (f.id === formatFacet ? ' on' : ''),
            text: f.label, title: f.hint, 'data-facet': f.id,
            on: { click: () => { formatFacet = f.id; drawForm(); } },
        }))),
        row('Find', field),
        list,
    ]);
}

function muxerRows(list) {
    const term = formatSearch.trim().toLowerCase();
    // Searching looks at everything. A facet is a way of not having to name
    // what you want; once you have named it, narrowing the answer to a group
    // you happened to be standing in would hide the entry you asked for.
    let matching = term
        ? muxers().filter((m) =>
              m.name.toLowerCase().indexOf(term) >= 0 ||
              (m.longName || '').toLowerCase().indexOf(term) >= 0 ||
              m.extensions.some((e) => e.indexOf(term) >= 0))
        : muxers().filter((m) => inFacet(m, formatFacet));

    // Under "Fits", the ones that *said* yes come before the ones that never
    // answered. That is not a ranking of which muxers are good — it is the
    // distinction the group is about, and without it the list opens on `avm2`
    // and `crc`, which are in it only because they have never been taught to
    // answer the question.
    if (!term && formatFacet === 'fits') {
        matching = matching.filter((m) => m.answersCodecs)
                           .concat(matching.filter((m) => !m.answersCodecs));
    }
    const shown = matching.slice(0, MUXER_LIMIT);

    const out = [div('ex-note dim', term
        ? `${matching.length} of ${muxers().length} match “${formatSearch.trim()}”`
        : `${matching.length} of ${muxers().length} muxers — search to reach the rest`)];

    for (const m of shown) {
        const tail = [];
        if (m.ext) tail.push(`.${m.extensions.join(' .')}`);
        if (m.device) tail.push('device');
        else if (m.noFile) tail.push('no file');
        if (m.stills) tail.push('pictures');
        if (!m.answersCodecs) tail.push('does not say');
        else if (!fits(m)) tail.push('not for these codecs');
        out.push(el('button', {
            cls: 'ex-fmt-row' + (m.name === settings.container ? ' on' : '') +
                 (fits(m) ? '' : ' misfit'),
            'data-muxer': m.name,
            title: m.longName || m.name,
            on: { click: () => pickMuxer(m.name) },
        }, [
            span(m.name, 'ex-fmt-name mono'),
            span(m.longName || '', 'dim'),
            span(tail.join(' · '), 'ex-fmt-tail dim'),
        ]));
    }
    if (matching.length > MUXER_LIMIT)
        out.push(div('ex-note dim',
                     `and ${matching.length - MUXER_LIMIT} more — narrow the search`));
    return out;
}

function pickMuxer(name) {
    const previous = settings.container;
    settings.container = name;
    const c = muxerInfo(name);
    // The codecs follow the container when the ones in hand will not fit: VP9
    // in an mp4 is legal but nothing plays it, and AAC in a WebM is not legal
    // at all. `c.videoCodec` is the muxer's own default resolved against what
    // this build can encode, so this cannot land on an encoder that is not
    // there — and where the muxer will hold nothing on offer it is left empty
    // and `warnings()` says so, rather than a codec being chosen that the
    // muxer would then refuse.
    if (c) {
        if (c.videoCodecs.indexOf(settings.videoCodec) < 0) settings.videoCodec = c.videoCodec;
        if (c.audioCodecs.indexOf(settings.audioCodec) < 0) settings.audioCodec = c.audioCodec;
    }
    // The muxer's options are its own; carrying `movflags` into Matroska would
    // stop the render dead at write_header, where an unknown key is an error.
    settings.extraFormat = {};
    // Only where the muxer has an extension of its own. Forty-seven have none,
    // and rewriting `take1.mkv` to `take1.out` because `tee` cannot answer the
    // question would be an answer nobody asked for.
    if (settings.path && c && c.ext) settings.path = withExtension(settings.path, outputExt());

    // Picking `tee` with a file already named makes that file the first
    // destination, because it is what somebody who has just settled on a
    // filename and then decided to also stream it means. An empty list would
    // throw the decision away and make the obvious next act "type it again".
    if (name === 'tee' && !settings.destinations.length) {
        const was = muxerInfo(previous);
        settings.destinations = [
            newDestination({ format: previous === 'tee' ? '' : previous,
                             path: settings.path }),
            newDestination(),
        ];
        if (!was) settings.destinations[0].format = '';
    }

    // image2 writes one file per frame and the numbering is in the filename,
    // so a path with no pattern in it is one picture overwritten on every
    // frame of the range. Nobody means that by picking image2, and finding out
    // afterwards means finding out from a folder with one file in it.
    if (name === 'image2' && settings.path) settings.path = withPattern(settings.path);
    followExtension();
    formatOpen = false;
    hooks.changed();
}

/// Every option the chosen muxer has, out of its own AVClass and libavformat's
/// generic one — the same column the encoder's options get and the same column
/// an input's demuxer gets on the Sources stage, because libavutil describes
/// all three with one structure. Applied by the same rule too: what is set here
/// goes to `av_opt_set`, and a key the muxer does not have stops the render
/// rather than being ignored.
function formatOptionRows() {
    const all = formatOptionsOf(settings.container);
    const out = optionColumn({
        name: 'fmtoptsearch',
        title: `${settings.container} options · ${all.length}`,
        note: `What ${settings.container} takes beyond its defaults, out of the muxer's own ` +
              'option table and libavformat’s generic one — both reach it the same way ' +
              'ffmpeg’s own arguments do.',
        options: all,
        bag: settings.extraFormat,
        hint: 'Anything set here is passed straight to the muxer.',
        onChange: () => hooks.changed(),
    });

    // And the protocol's, when the destination is a URL. **One bag, two
    // objects**: the muxer takes what it recognises and libavformat hands the
    // rest down to the AVIO layer, which is what the Sources stage already does
    // at the reading end and is why these are edited into `extraFormat` rather
    // than into a second dictionary. `srt` reports thirty-odd options here,
    // `rtmp` about twenty, and none of them is reachable any other way.
    //
    // Only where *this* render's destination is a URL. A `tee` has several
    // destinations and several protocols between them, and one column feeding
    // one bag could not say which of them it was for — so a tee destination
    // carries its own options in its own brackets instead.
    const scheme = kindOf(muxerInfo(settings.container) || {}) === 'stream'
        ? schemeOf(settings.path) : '';
    if (scheme) {
        let opts = [];
        try { opts = bro.ffmpeg.protocolOptions(scheme) || []; } catch (e) { opts = []; }
        if (opts.length)
            out.push(...optionColumn({
                name: 'protooptsearch',
                title: `${scheme} options · ${opts.length}`,
                note: 'The protocol’s own — timeouts, buffer sizes, certificates, latency. ' +
                      'They travel in the same bag the muxer’s do, and a key neither of ' +
                      'them has stops the render rather than being ignored.',
                options: opts,
                bag: settings.extraFormat,
                hint: 'Anything set here is passed straight to the protocol.',
                onChange: () => hooks.changed(),
            }));
    }
    return out;
}

// ── video ──────────────────────────────────────────────────────────────────

function videoRows(codec, info, cont) {
    const rows = [];

    // Codecs the chosen container will actually hold come first; the rest are
    // still listed, because refusing to show them hides the reason the one you
    // wanted is missing.
    // And an encoder that runs on a card says so in the menu. It is not a
    // decoration: which encoder this is decides whether the render can keep its
    // pictures on the card at all, and it is the *only* hardware decision in
    // this application that is measurably a win.
    const label = (e, legal) =>
        e.label + (isHardwareEncoder(e.id) ? `  · ${deviceOfEncoder(e.id)}` : '') +
        (legal.indexOf(e.id) < 0 ? `  (not in ${settings.container})` : '');

    rows.push(row('Codec', select(
        { 'data-f': 'vcodec', on: { change: (e) => { settings.videoCodec = e.target.value; hooks.changed(); } } },
        videoEncoders().map((e) => ({ id: e.id, label: label(e, cont.videoCodecs) })),
        codec)));
    if (info.longName) rows.push(row('', note(info.longName)));
    if (isHardwareEncoder(codec))
        rows.push(row('', span(encodeCost + ' A graph that ends on the same card hands ' +
                               'this encoder its frames without a copy.', 'dim')));

    rows.push(...rateRows(codec, info));

    if (info.presets && info.presets.length)
        rows.push(row('Speed', select({ 'data-f': 'preset', on: { change: set('preset') } },
                                       info.presets, settings.preset)));
    if (info.tunes && info.tunes.length)
        rows.push(row('Tune', select({ 'data-f': 'tune', on: { change: set('tune') } },
                                     [{ id: '', label: 'none' }, ...info.tunes], settings.tune)));
    if (info.profiles && info.profiles.length)
        rows.push(row('Profile', select({ 'data-f': 'profile', on: { change: set('profile') } },
                                        [{ id: '', label: 'auto' }, ...info.profiles], settings.profile)));
    if (info.pixelFormats && info.pixelFormats.length) {
        const preferred = info.pixelFormats.indexOf('yuv420p') >= 0 ? 'yuv420p' : info.pixelFormats[0];
        rows.push(row('Pixels', select({ 'data-f': 'pixfmt', on: { change: set('pixelFormat') } },
                                       [{ id: '', label: `auto (${preferred})` }, ...info.pixelFormats],
                                       settings.pixelFormat)));
    }

    rows.push(...sizeRows());

    rows.push(row('Frame rate', select(
        { 'data-f': 'fps', on: { change: (e) => { settings.fps = Number(e.target.value) || 0; hooks.changed(); } } },
        [{ id: 0, label: `Project (${(project.fps || 30).toFixed(3)})` },
         ...[23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120].map((f) => ({ id: f, label: String(f) }))],
        settings.fps)));

    return rows;
}

function rateRows(codec, info) {
    if (info.alwaysLossless)
        return [row('Rate', span('always lossless — there is nothing to choose', 'dim'))];

    const modes = rateModes(codec);
    const rows = [row('Rate', segmented('rate',
        modes.map((m) => ({ v: m, l: RATE_LABELS[m], title: RATE_HINTS[m] })),
        settings.rate,
        (v) => { settings.rate = v; hooks.changed(); }))];

    if (settings.rate === 'quality' && modes.indexOf('quality') >= 0) {
        const q = qualityRange(codec);
        qualityLabel = span('', 'mono dim');
        qualityLabel.id = 'ex-qval';
        const slider = el('input', {
            'data-f': 'quality', type: 'range', min: q.min, max: q.max, value: settings.quality,
            on: { input: () => {
                settings.quality = Number(slider.value);
                // Not a full redraw: dragging a slider that rebuilds the form
                // under the pointer loses the drag on the first move.
                refreshQualityLabel();
                hooks.tweaked();
            } },
        });
        rows.push(row('Quality', btns([slider, qualityLabel])));
        refreshQualityLabel();
    }
    if (settings.rate === 'bitrate' || settings.rate === 'twopass' ||
        settings.rate === 'constrained') {
        rows.push(row('Bitrate', num('vbitrate',
            { min: 1, max: 500000, step: 500, value: settings.videoBitrate,
              on: { change: number('videoBitrate', 1) } }, 'kbps')));
    }
    if (settings.rate === 'twopass') {
        // What two-pass costs and what it cannot promise, said where it is
        // chosen. **Whether an encoder acts on `-pass` is the one thing
        // libavcodec will not answer in advance** — there is no capability flag
        // for it and no option to ask about, and this is the third place in
        // this application where a capability genuinely cannot be queried. So
        // the control does exactly what it says (it writes `-pass 1` and
        // `-pass 2`, as the command line does) and the render says afterwards
        // if the encoder kept its statistics somewhere else.
        rows.push(row('', note(
            'The range is rendered twice: once to measure where the bits are needed, ' +
            'and once to spend them. Twice the time, and the closest an encoder can get ' +
            'to a size you have to hit. What comes out of pass one is a statistics file ' +
            'beside the output, and a render whose encoder ignored -pass says so in the ' +
            'report rather than pretending.')));
    }
    if (settings.rate === 'constrained') {
        rows.push(row('Ceiling', num('maxrate',
            { min: 0, max: 500000, step: 500,
              value: settings.maxrate || Math.round(settings.videoBitrate * 1.5),
              on: { change: number('maxrate', 0) } }, 'kbps')));
        rows.push(row('Buffer', num('bufsize',
            { min: 0, max: 500000, step: 500,
              value: settings.bufsize || settings.videoBitrate * 3,
              on: { change: number('bufsize', 0) } }, 'kbit')));
    }
    return rows;
}

function sizeRows() {
    const w = el('input', { cls: 'num', 'data-f': 'w', type: 'number', min: 16, max: 16384,
                            value: settings.width, on: { change: resize } });
    const h = el('input', { cls: 'num', 'data-f': 'h', type: 'number', min: 16, max: 16384,
                            value: settings.height, on: { change: resize } });
    function resize() {
        settings.width = Math.max(16, Number(w.value) || project.width);
        settings.height = Math.max(16, Number(h.value) || project.height);
        hooks.changed();
    }

    const preset = (label, apply) => el('button', {
        cls: 'tiny', text: label, 'data-size': label.toLowerCase(),
        on: { click: () => { apply(); hooks.changed(); } },
    });

    return [
        row('Size', btns([w, span('×', 'dim'), h])),
        row('', btns([
            preset('Canvas', () => { settings.width = project.width; settings.height = project.height; }),
            preset('4K', () => { settings.width = 3840; settings.height = 2160; }),
            preset('1080p', () => { settings.width = 1920; settings.height = 1080; }),
            preset('720p', () => { settings.width = 1280; settings.height = 720; }),
            preset('Half', () => { settings.width = even(project.width / 2);
                                   settings.height = even(project.height / 2); }),
        ], 'btns even')),
    ];
}

function even(n) { return Math.max(16, Math.round(n / 2) * 2); }

// ── audio ──────────────────────────────────────────────────────────────────

function audioRows(cont) {
    // Through setAudioIncluded rather than by writing the flag: the Write
    // stage's audio rows and this switch are two halves of one decision, and
    // two switches for one decision is how a render comes out silent while a
    // track list insists it should not have.
    const rows = [row('Include', btns(el('button', {
        cls: 'tiny' + (settings.audio ? ' on' : ''), 'data-f': 'audio',
        text: settings.audio ? 'On' : 'Off',
        on: { click: () => { setAudioIncluded(!settings.audio); hooks.changed(); } },
    })))];
    if (!settings.audio) return rows;

    const info = audioInfo(settings.audioCodec) || { sampleRates: [], channelCounts: [] };
    const label = (e) =>
        e.label + (cont.audioCodecs.indexOf(e.id) < 0 ? `  (not in ${settings.container})` : '');

    rows.push(row('Codec', select(
        { 'data-f': 'acodec', on: { change: (e) => { settings.audioCodec = e.target.value; hooks.changed(); } } },
        audioEncoders().map((e) => ({ id: e.id, label: label(e) })), settings.audioCodec)));

    if (!info.lossless)
        rows.push(row('Bitrate', btns([
            select({ 'data-f': 'abitrate', on: { change: number('audioCodecBitrate', 8) } },
                   [64, 96, 128, 160, 192, 256, 320, 448].map(String),
                   String(settings.audioCodecBitrate)),
            span('kbps', 'dim'),
        ])));
    if (info.sampleRates.length > 1)
        rows.push(row('Rate', btns([
            select({ 'data-f': 'arate', on: { change: number('sampleRate', 1) } },
                   info.sampleRates.map(String), String(settings.sampleRate)),
            span('Hz', 'dim'),
        ])));
    if (info.channelCounts.length > 1)
        rows.push(row('Channels', select(
            { 'data-f': 'ach', on: { change: number('channels', 1) } },
            info.channelCounts.map((n) => ({
                id: String(n),
                label: n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} channels`,
            })), String(settings.channels))));
    return rows;
}

// ── advanced ───────────────────────────────────────────────────────────────

const SCALERS = ['bicubic', 'bilinear', 'lanczos', 'spline', 'area', 'gauss', 'neighbor'];
const COLOURS = [{ id: 'auto', label: 'auto (by height)' }, { id: 'bt709', label: 'BT.709 (HD)' },
                 { id: 'bt601', label: 'BT.601 (SD)' }, { id: 'bt2020', label: 'BT.2020 (wide)' }];

function advancedRows(codec) {
    const title = el('input', {
        cls: 'wide', 'data-f': 'title', type: 'text', value: settings.title,
        placeholder: 'written as metadata',
        on: { change: () => { settings.title = title.value; } },
    });

    return [
        head('Advanced'),
        row('Keyframes', num('gop', { min: 0, max: 60, step: 0.5, value: settings.gopSeconds,
                                         on: { change: number('gopSeconds', 0) } },
                             'seconds (0 = encoder default)')),
        ...keyframeRows(),
        row('B-frames', num('bf', { min: -1, max: 16, value: settings.bframes,
                                       on: { change: number('bframes', -1) } },
                            '-1 = leave alone')),
        ...timingRows(),
        row('Scaler', select({ 'data-f': 'scaler', on: { change: set('scaler') } },
                             SCALERS, settings.scaler)),
        row('Colour', select({ 'data-f': 'cspace', on: { change: set('colorspace') } },
                             COLOURS, settings.colorspace)),
        row('Range', segmented('crange', [{ v: 'tv', l: 'Limited' }, { v: 'pc', l: 'Full' }],
                               settings.colorRange,
                               (v) => { settings.colorRange = v; hooks.changed(); })),
        row('Faststart', btns(el('button', {
            cls: 'tiny' + (settings.faststart ? ' on' : ''), 'data-f': 'faststart',
            text: settings.faststart ? 'On' : 'Off',
            title: 'Move the index to the front of an mp4',
            on: { click: () => { settings.faststart = !settings.faststart; hooks.changed(); } },
        }))),
        row('Title', title),
        ...rawOptionRows(codec),
    ];
}

// ── where the keyframes go ─────────────────────────────────────────────────
//
// `-g` says how *often*; this says *where*, which is a different question and
// the more useful one. **A keyframe where an edit cuts is what makes a file
// that can be cut again** — every editor and every stream packager has to start
// a segment on one, so a cut that falls in the middle of a GOP costs a re-encode
// of everything up to it.
//
// The interesting mode is `Cut points`, and what makes it honest is that
// nothing is copied: what is remembered is the decision, and `forceKeyFrames()`
// re-reads the timeline every time it is asked. Drag a clip afterwards and the
// list follows it; a version that wrote the numbers into a field when the button
// was pressed would go on naming moments nothing cuts at.

const KEYFRAME_MODES = [
    { v: 'none', l: 'Off', title: 'Whatever the GOP length produces' },
    { v: 'cuts', l: 'Cut points', title: 'One wherever the edit cuts, followed live' },
    { v: 'times', l: 'Times', title: 'A list of seconds into the output' },
    { v: 'expr', l: 'Expression', title: 'ffmpeg’s own, evaluated per frame' },
];

function keyframeRows() {
    const rows = [row('Force at', segmented('kfmode', KEYFRAME_MODES, settings.keyframeMode,
                                            (v) => { settings.keyframeMode = v; drawForm();
                                                     hooks.changed(); }))];

    if (settings.keyframeMode === 'cuts') {
        const at = cutPoints(range());
        rows.push(row('', note(at.length
            ? `${at.length} cut${at.length === 1 ? '' : 's'} inside the range — ` +
              `${at.map((t) => t.toFixed(2)).join(', ')} s into the file. Read from the ` +
              'timeline every time, so moving a clip moves the keyframe with it.'
            : 'No cut falls inside the range, so this asks for nothing. Split a clip or ' +
              'widen the range and the keyframes follow.')));
    }
    if (settings.keyframeMode === 'times') {
        const f = el('input', {
            cls: 'wide', 'data-f': 'kftimes', type: 'text', value: settings.keyframeTimes,
            placeholder: '1.5,4,00:00:08.5',
            on: { change: () => { settings.keyframeTimes = f.value.trim(); hooks.changed(); } },
        });
        rows.push(row('At', f));
        rows.push(row('', note(
            'Seconds into the *output*, which is what ffmpeg means by them — so the same ' +
            'command run elsewhere writes the same file. A moment between two frames lands ' +
            'on the one after it.')));
    }
    if (settings.keyframeMode === 'expr') {
        const f = el('input', {
            cls: 'wide', 'data-f': 'kfexpr', type: 'text', value: settings.keyframeExpr,
            placeholder: 'gte(t,n_forced*2)',
            on: { change: () => { settings.keyframeExpr = f.value.trim(); hooks.changed(); } },
        });
        rows.push(row('expr:', f));
        rows.push(row('', note(
            'libavutil’s evaluator, per frame, over n, t, n_forced, prev_forced_n and ' +
            'prev_forced_t. One that will not parse stops the render rather than being ' +
            'quietly dropped.')));
    }
    return rows;
}

// ── how the frames are timed and shaped ────────────────────────────────────

const FIELD_ORDERS = [
    { v: '', l: 'Progressive' },
    { v: 'tt', l: 'Top first' },
    { v: 'bb', l: 'Bottom first' },
];
const THREAD_TYPES = [{ id: '', label: 'auto' }, { id: 'frame', label: 'frame' },
                      { id: 'slice', label: 'slice' },
                      { id: 'frame+slice', label: 'frame + slice' }];

function timingRows() {
    const rows = [];

    // **`-fps_mode` is stated, not chosen.** This renderer walks the range
    // forward at a fixed output rate and stamps every frame with its index —
    // both paths do, the compositor because it samples the edit at t and the
    // graph because the writer numbers what comes out of the sink. So `cfr` is
    // not a setting, it is a fact, and a picker offering `vfr` or `passthrough`
    // would be offering two things this render cannot produce.
    rows.push(row('Frame timing', span('-fps_mode cfr', 'mono dim')));
    rows.push(row('', note(
        'Constant, by construction: the render walks the range at the output rate and ' +
        'stamps each frame with its number. Variable frame rate is not something either ' +
        'render path can express, so it is not offered.')));

    rows.push(row('Field order', segmented('fieldorder', FIELD_ORDERS, settings.fieldOrder,
                                           (v) => { settings.fieldOrder = v; drawForm();
                                                    hooks.changed(); })));
    if (settings.fieldOrder)
        rows.push(row('', note(
            'The encoder is put into field mode and every frame is marked to match. What ' +
            'is composited here is progressive, so this is right for footage that was ' +
            'interlaced and has come through untouched, and a claim about the picture ' +
            'otherwise — and the chroma of a 4:2:0 output is subsampled across both ' +
            'fields either way.')));

    rows.push(row('Threads', btns([
        num('threads', { min: 0, max: 64, value: settings.threads,
                         on: { change: number('threads', 0) } }, '0 = all cores'),
        select({ 'data-f': 'threadtype', on: { change: set('threadType') } },
               THREAD_TYPES, settings.threadType),
    ])));

    rows.push(row('Shortest', btns(el('button', {
        cls: 'tiny' + (settings.shortest ? ' on' : ''), 'data-f': 'shortest',
        text: settings.shortest ? 'On' : 'Off',
        title: 'End the file where the content ends rather than where the range does',
        on: { click: () => { settings.shortest = !settings.shortest; drawForm();
                             hooks.changed(); } },
    }))));
    if (settings.shortest)
        rows.push(row('', note(
            'The render stops at the first frame with nothing left to draw, instead of ' +
            'writing the rest of the range as black.')));

    return rows;
}

/// Every option the chosen encoder has, straight from its AVOption table.
///
/// This is the part that earns the column: libavcodec knows exactly what x265
/// will take, complete with types, ranges, defaults and help text, and none of
/// it has to be duplicated here to be offered. Drawn by the shared component in
/// ui/opttable.js — see there for why the muxer's, the demuxer's and this one
/// are not three implementations.
function rawOptionRows(codec) {
    const all = optionsOf(codec);
    return optionColumn({
        name: 'optsearch',
        title: `${codec} options · ${all.length}`,
        options: all,
        bag: settings.extraVideo,
        hint: 'Anything set here is passed straight to the encoder.',
        onChange: () => hooks.changed(),
    });
}

// ── the small change handlers ──────────────────────────────────────────────

/// A select that writes one string setting.
function set(key) {
    return (e) => { settings[key] = e.target.value; hooks.changed(); };
}

/// A field that writes one number setting, floored.
function number(key, min) {
    return (e) => { settings[key] = Math.max(min, Number(e.target.value) || 0); hooks.changed(); };
}

function refreshQualityLabel() {
    if (!qualityLabel) return;
    const r = qualityRange(activeVideoCodec());
    // The scale runs backwards from every other quality control in the app and
    // its ends move with the encoder, so it says where you are on it rather
    // than showing a bare number.
    const t = (settings.quality - r.min) / Math.max(1, r.max - r.min);
    const word = t <= 0.02 ? 'lossless' : t < 0.3 ? 'near-lossless'
               : t < 0.45 ? 'high' : t < 0.62 ? 'good' : 'small file';
    qualityLabel.textContent = `${settings.quality} · ${word}`;
}
