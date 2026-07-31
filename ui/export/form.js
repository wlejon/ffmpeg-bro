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

import { project, projectFps } from '../project.js';
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
         range, freshSpec, effectiveFpsMode } from './spec.js';
import { cutPoints } from './options.js';
import { isHardwareEncoder, deviceOfEncoder, encodeCost,
         chooseFor, applyChoice } from '../hardware.js';
import { inputs } from '../inputs.js';
import { optionColumn } from '../opttable.js';
import { setAudioIncluded } from './streams.js';
import { kindOf, describeKind, schemeOf, protocolLinked,
         newDestination, destinationRows } from './destination.js';
import { newVersion, versionSize } from './versions.js';
import { explained, why, onExplainChange } from './explain.js';

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
    // The Destination column has ⓘs of its own and the master button is in the
    // column beside it, so both have to reach this draw.
    onExplainChange(() => drawForm());
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
    //
    // The heading is inside `outputRows()` now rather than in front of it,
    // because there are two of them: the band has a cell each for where it goes
    // and what it is written as, and a single "Destination" over both would be
    // one word claiming to name two questions.
    put(panes.dest, () => outputRows());

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
///
/// **A band of two cells rather than a column of rows**, and the division is by
/// question rather than by size: *where it goes* on the left, *what it is
/// written as* on the right. Everything else sorts itself under one of the two
/// without being told to — a version and a reconnection are things that happen
/// to a destination, and the muxer's option table belongs to the muxer.
///
/// The left cell is the wide one because the path is in it. That control is the
/// reason the band exists: it is the widest value on this stage, it is the one
/// value that has to be read all the way to the end, and a 320px column showed
/// `D:\obs-recording\2026-07-30_04-48-25-exp` and stopped — the exact failure
/// the note on `.ex-target` was written against, reintroduced one level up.
function outputRows() {
    const muxer = muxerInfo(settings.container) || { name: settings.container };
    const kind = kindOf(muxer);
    const all = formatOptionsOf(settings.container);

    // **The path is the width of the cell and the cell is most of the window.**
    // It used to be the third row of a key/value grid, which gave the single
    // control everybody walks to this stage to set a 140px box showing
    // `D:\obs-recording\2026-07-3(` — the one field on the stage whose whole
    // value has to be legible, elided in the middle. What it was under was a
    // labelled row saying "Goes to: one file" and a paragraph explaining what a
    // file is; both are still here, in the cell beside it, where an answer
    // belongs relative to the thing it is about.
    const where = [explained('destination', 'Write to')];

    // One encode, several places. The rows live in `destination.js` beside the
    // escaping they are built to avoid, because a recording writes through a
    // muxer too and edits the same list with the same rows.
    if (kind === 'several')
        where.push(...destinationRows({ list: settings.destinations,
                                        changed: () => hooks.changed(),
                                        first: 'matroska' }));
    else where.push(...oneTargetRows(kind));

    // Both of these are about the destination rather than about the muxer — one
    // is another destination and one is what happens when this one goes away —
    // so they go under it rather than under the format.
    where.push(...keepTryingRows(kind));
    where.push(...versionRows());

    const what = [head('Format'),
                  ...formatRows(kind),
                  why('destination', describeKind(kind, muxer)),
                  head(`${showFormatOptions ? '▾' : '▸'} ${settings.container} options · ` +
                       `${all.length}`, {
                      'data-f': 'formatopts',
                      cls: 'section-head ex-toggle',
                      on: { click: () => { showFormatOptions = !showFormatOptions;
                                           drawForm(); } },
                  })];

    return [div('ex-band', [div('ex-band-where', where), div('ex-band-what', what)])];
}

// ── a destination that is allowed to go away ───────────────────────────────
//
// **One decision with four dials, not eleven checkboxes.** What somebody
// streaming to an RTMP endpoint wants is "keep going if it drops"; what that is
// in ffmpeg is the `fifo` pseudo-muxer wrapped around the muxer they picked.
// The app's job is to know that, so `Keep trying if it drops` is the control and
// `-f fifo -fifo_format flv -attempt_recovery 1` is what it means — printed in
// full by the command bar, which is where the claim that nothing reaches ffmpeg
// unseen is kept.
//
// Everything a dial *says about itself* is libav's. The help text, the range and
// the number a blank field means are read out of `muxerOptions('fifo')`, so a
// build whose fifo grew a bigger default queue says so here with no edit.

/// One option of the fifo muxer, as libav describes it. Cached for the reason
/// every other option table on this stage is: the panel is rebuilt on every
/// keystroke in a search box.
let fifoTable = null;
function fifoOption(name) {
    if (!fifoTable) {
        try { fifoTable = bro.ffmpeg.muxerOptions('fifo') || []; } catch (e) { fifoTable = []; }
    }
    return fifoTable.find((o) => o.name === name) || null;
}

/// Is there a `fifo` muxer in this build at all?
///
/// Asked rather than assumed, like every other capability here: it is compiled
/// in with threads and a build without them has no such muxer, and a control
/// that offered one would fail at `avformat_alloc_output_context2`.
const hasFifo = () => !!(bro.ffmpeg.muxers || []).some((m) => m.name === 'fifo');

/// A number field whose blank value means "whatever the muxer's own default is",
/// with that default in the placeholder so the blank is not a mystery.
function fifoNum(name, optionName, value, sentinel, apply, unit) {
    const o = fifoOption(optionName);
    const shown = value === sentinel ? '' : String(value);
    const field = el('input', {
        cls: 'num', 'data-f': name, type: 'number', value: shown,
        placeholder: o && o.default !== '' ? o.default : 'default',
        title: o ? `${optionName} — ${o.help}` : optionName,
        on: { change: () => {
            const v = field.value.trim();
            apply(v === '' ? sentinel : Number(v));
            hooks.changed();
        } },
    });
    return btns([field, unit ? span(unit, 'dim') : null]);
}

function keepTryingRows(kind) {
    if (!hasFifo()) return [];
    const k = settings.keepTrying;

    // A tee is refused rather than quietly given one, and the refusal names the
    // form that does work. See `keepTrying()` in spec.js for the argument; it is
    // stated here because this is where somebody would look for the control.
    if (kind === 'several')
        return [row('If it drops', note(
            'One fifo in front of several destinations is one queue and one recovery for ' +
            'all of them, so a single flaky endpoint would take the others down and back ' +
            'with it. Per destination it works and is what ffmpeg’s own documentation ' +
            'writes: set that destination’s -f to fifo and give it fifo_format=<muxer> in ' +
            'its options.'))];
    // A file on this machine does not drop and come back. Said rather than
    // hidden only where it is nearly relevant — a set of segments going to a
    // local folder is not what this is about either.
    if (kind !== 'stream') return [];

    const rows = [
        row('If it drops', btns(el('button', {
            cls: 'tiny' + (k.on ? ' on' : ''), 'data-f': 'keeptrying',
            text: k.on ? 'Keep trying' : 'Fail the render',
            title: 'Wrap the muxer in ffmpeg’s fifo, which queues packets and reconnects ' +
                   'rather than ending the render when the destination goes away',
            on: { click: () => { k.on = !k.on; hooks.changed(); } },
        }))),
    ];
    if (!k.on) {
        rows.push(row('', note(
            'The render ends when the destination stops accepting it, with libav’s own ' +
            'message in the report and whatever had been sent already closed properly.')));
        return rows;
    }

    rows.push(row('Queue', fifoNum('fifoqueue', 'queue_size', k.queueSize, 0,
                                   (v) => { k.queueSize = Math.max(0, Math.round(v) || 0); },
                                   'packets')));
    rows.push(row('Wait', fifoNum('fifowait', 'recovery_wait_time', k.waitSeconds, -1,
                                  (v) => { k.waitSeconds = Number.isFinite(v) && v >= 0 ? v : -1; },
                                  'seconds between attempts')));
    rows.push(row('Give up after', fifoNum('fifoattempts', 'max_recovery_attempts',
                                           k.maxAttempts, 0,
                                           (v) => { k.maxAttempts = Math.max(0, Math.round(v) || 0); },
                                           'attempts — blank never gives up')));
    // **Two choices where ffmpeg has three, and the missing one is fifo's own
    // default.** `drop_pkts_on_overflow` off means the render *blocks* on a full
    // queue, and `fifo_thread_recover` loops on EAGAIN while it is off — so a
    // destination that never comes up leaves the consumer retrying for ever
    // while the render thread waits inside `av_interleaved_write_frame`, and
    // Stop, which is checked once per output frame, never arrives. Measured: a
    // four-second render to a closed port with two recovery attempts ran for
    // twenty seconds and ignored a cancel. Blocking is right for a destination
    // that is merely slow and stays reachable to a spec written by hand; nothing
    // on this stage produces one. The note below says so rather than leaving a
    // control that is quietly absent.
    rows.push(row('When it fills', segmented('fifofull', [
        { v: 'drop', l: 'Drop', title: 'drop_pkts_on_overflow — the render keeps its own ' +
                                       'pace and the oldest packets are thrown away' },
        { v: 'keyframe', l: 'Drop, resume on a keyframe',
          title: 'restart_with_keyframe — the same, and after a drop nothing is sent until ' +
                 'a keyframe, so the far end has a picture to start from' },
    ], k.restartWithKeyframe ? 'keyframe' : 'drop', (v) => {
        k.restartWithKeyframe = v === 'keyframe';
        hooks.changed();
    })));
    rows.push(why('keep-trying',
        'This is -f fifo in front of the muxer, with -fifo_format naming it. A render that ' +
        'reconnected says so in the report and counts how many times — what was happening ' +
        'while the destination was gone is not in the file, so a recovered render is not the ' +
        'same as one that never dropped. A blank field is the fifo muxer’s own default. ' +
        'fifo’s third mode, blocking until the queue drains, is not offered: a blocked ' +
        'render whose destination never comes up cannot be stopped.'));
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
        cls: 'ex-target-path', 'data-f': 'path', type: 'text', value: settings.path,
        placeholder: kind === 'stream' ? 'a URL to push the render to'
                                       : 'where the file goes',
        on: { change: () => {
            settings.path = path.value.trim();
            // **A filename is not a picture.** `referenceKey()` deliberately
            // leaves the path out, so naming the file must not throw away a
            // candidate render and the PSNR numbers under the wipe that cost
            // ten seconds to produce — the same division the stream rows draw
            // between `changed` and `restated`, and it is felt here because
            // setting a filename is the one thing everybody walks over to the
            // Write stage to do, usually after looking at the comparison.
            //
            // The exception is image2, where the extension names a *codec*
            // rather than a container: `out.png` really does change what the
            // encoder is, and then the candidate is genuinely of something
            // else. `followExtension()` is the only thing here that can do it,
            // so asking whether it did is the whole test.
            const was = settings.videoCodec;
            followExtension();
            refreshFileLabel();
            if (settings.videoCodec !== was) hooks.changed();
            else hooks.restated();
        } },
    });

    fileLabel = span('', 'dim mono');
    fileLabel.classList.add('ex-dir');
    refreshFileLabel();

    // Outside the key/value grid, so it is the width of the column: a path is
    // the one value on this stage that is read left to right and all the way to
    // the end, and a label beside it would be a word costing a third of it.
    const rows = [div('ex-target', path)];

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
        rows.push(why('destination',
            'A protocol’s own options are in the column beside the muxer’s. They travel in ' +
            'one bag, which is what libavformat does with what a muxer does not recognise — ' +
            'and a key neither takes stops the render rather than being ignored.'));
    } else {
        // Only where there is a file to choose. A dialog for a URL would be a
        // dialog that cannot say what is being asked for.
        rows.push(div('ex-target-under', [
            el('button', { cls: 'tiny', 'data-f': 'browse', text: 'Choose…',
                           on: { click: () => browse(path) } }),
            fileLabel,
        ]));
    }

    rows.push(...numberingRows(path));
    return rows;
}

// ── the same edit, written twice ────────────────────────────────────────────
//
// Under the destination and not among the tee rows, because it is the question
// people arrive at the tee rows looking for and do not find. `tee` is one
// encode to several places; this is several encodes of one edit. The heading
// says which is which, once, where somebody about to pick the wrong one is
// standing — see ui/export/versions.js.

function versionRows() {
    const list = settings.versions || [];
    const rows = [explained('versions', `${list.length ? '▾' : '▸'} Also write · ${list.length}`, {
        'data-f': 'versions',
        cls: 'section-head ex-head ex-toggle',
        // No fold of its own: the list *is* the disclosure. Empty it is one
        // line, and a render with a proxy configured is a render where that is
        // worth seeing without opening anything.
        on: { click: () => { if (!list.length) addVersion(); } },
    })];

    if (!list.length) {
        rows.push(why('versions',
            'One encode to several places is the tee muxer, above. This is the other one: ' +
            'the same edit encoded again at another size — a 1080p master and a 720p proxy, ' +
            'which no single encoder can produce, because an encoder has one frame size.'));
        return rows;
    }

    list.forEach((v, i) => {
        const target = el('input', {
            cls: 'wide', 'data-f': `ver-path-${i}`, type: 'text', value: v.path,
            placeholder: 'where this one goes',
            on: { change: () => { v.path = target.value.trim(); hooks.changed(); } },
        });
        const muxer = el('input', {
            cls: 'wide', 'data-f': `ver-format-${i}`, type: 'text', value: v.format,
            placeholder: 'the render’s, unless this says otherwise',
            on: { change: () => { v.format = muxer.value.trim(); hooks.changed(); } },
        });
        // One side is enough and the other is worked out from the render's
        // aspect — see `versionSize`. Both blank is not a version at all, which
        // is what `activeVersions` refuses: a second encode of exactly the
        // master is a file copy done the expensive way.
        const w = el('input', {
            cls: 'num', 'data-f': `ver-w-${i}`, type: 'number', min: '0',
            value: String(v.width || ''), placeholder: 'auto',
            on: { change: () => {
                v.width = Math.max(0, Math.round(Number(w.value) || 0));
                hooks.changed();
            } },
        });
        const h = el('input', {
            cls: 'num', 'data-f': `ver-h-${i}`, type: 'number', min: '0',
            value: String(v.height || ''), placeholder: 'auto',
            on: { change: () => {
                v.height = Math.max(0, Math.round(Number(h.value) || 0));
                hooks.changed();
            } },
        });

        const size = versionSize(v, settings.width || project.width || 1920,
                                 settings.height || project.height || 1080);
        rows.push(head(`Version ${i + 1}`, { cls: 'section-head' }));
        rows.push(row('Size', btns([w, span('×', 'dim'), h])));
        rows.push(row('', note(v.width && v.height
            ? `${size.width} × ${size.height}`
            : `${size.width} × ${size.height} — the other side follows the render’s aspect`)));
        rows.push(row('-f', muxer));
        rows.push(row('To', target));
        rows.push(row('', btns([
            el('button', { cls: 'tiny', 'data-f': `ver-drop-${i}`, text: 'Remove',
                           on: { click: () => {
                               settings.versions.splice(i, 1);
                               hooks.changed();
                           } } }),
        ])));
    });

    // What is wrong with the list is said in `warnings()`, above the Render
    // button, and not again here. Two encodes aimed at one path is a render
    // that succeeds and is wrong, which is precisely what that list is; a
    // second copy of the sentence beside the row would be a second place that
    // has to be kept saying the same thing.
    rows.push(row('', btns([
        el('button', { cls: 'tiny', 'data-f': 'ver-add', text: '+ Version',
                       on: { click: addVersion } }),
    ])));
    rows.push(why('versions',
        'Another whole encode of the same edit: the muxer, the codec, the rate control, ' +
        'the streams and the range are this render’s, and only the size and where it goes ' +
        'are its own. CRF is a quality target rather than a bitrate, so the smaller one ' +
        'comes out smaller without being told to.'));
    return rows;
}

/// A version pre-filled with the obvious first answer: half the render's width,
/// beside the render's own file. Both are guesses somebody will change — the
/// point is that a row arrives meaning something rather than empty, since an
/// empty one is not a version and would be silently skipped.
function addVersion() {
    const w = settings.width || project.width || 1920;
    const half = Math.max(16, Math.round(w / 2) & ~1);
    settings.versions.push(newVersion({
        width: half,
        path: settings.path ? proxyPath(settings.path, half) : '',
    }));
    hooks.changed();
}

/// `master.mp4` at 960 wide is `master-960.mp4`. The number rather than the
/// word "proxy", because a render can have several versions and two files
/// called proxy is the failure this is trying to keep somebody out of.
function proxyPath(path, width) {
    const cut = String(path).replace(/(\.[^./\\]*)$/, '');
    const ext = String(path).slice(cut.length);
    return `${cut}-${width}${ext}`;
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

/// The muxer, and what shape of destination it makes.
///
/// **One line, because they are one answer.** "mp4" and "one file" were two
/// labelled rows a paragraph apart, and between them they say a single thing:
/// what is about to be written. Read together they also catch the case that used
/// to need reading twice — `hls` beside "a set of files" is the muxer telling
/// you it will not write the file you named it with.
function formatRows(kind) {
    const m = muxerInfo(settings.container) || { name: settings.container, label: '', extensions: [] };
    const stated = div('ex-fmt-current', [
        span(m.name, 'mono'),
        span(KIND_LABELS[kind] || '', 'ex-fmt-kind'),
        el('button', {
            cls: 'tiny', 'data-f': 'container-open', text: formatOpen ? 'Close' : 'Change',
            on: { click: () => { formatOpen = !formatOpen; formatSearch = ''; drawForm(); } },
        }),
    ]);

    // The muxer's own long name goes on the line under it rather than beside
    // it. Three things and a button on one line in a 320px column is how "MP4
    // (MPEG-4 Part 14)" came out as "MP4 (MP" — and the long name is the half
    // somebody unsure which muxer they are looking at is reading.
    //
    // **Not in a labelled row, because the heading over the cell is the label.**
    // `Format: mp4` under a heading reading FORMAT is the word twice and a 92px
    // key gutter indenting everything under it for the sake of the repetition.
    const rows = [stated,
                  div('ex-note dim', [m.longName, describeMuxer(m)].filter(Boolean).join(' · '))];
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
    rows.push(...chooseRows(codec));

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
        [{ id: 0, label: `Project (${projectFps().toFixed(3)})` },
         ...[23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120].map((f) => ({ id: f, label: String(f) }))],
        settings.fps)));

    return rows;
}

// What the last press decided, kept so it stays on the screen.
//
// **Not in `settings`**, because it is not part of the render: it is a sentence
// about a decision that has already been written into the controls above it, and a
// render is not different for having been arrived at by pressing a button. Held for
// the same reason `formatOpen` is — it is where you are, not what will be written.
let chosenNote = '';

/// `Choose for me`, and the sentence it leaves behind.
///
/// **The whole cost of the press is having to say what it did**, so the sentence is
/// the feature and the button is the way in. The rule is ui/hardware.js's — software
/// decode, hardware encode, above SD — measured on this machine and written down in
/// docs/manual/card.md; what is here is the press, the two writes it makes, and the
/// line it leaves.
///
/// **Never on load**, which is the alternative rejected: a render whose encoder was
/// quietly rewritten when the stage opened would be the "use hardware acceleration"
/// checkbox this application deliberately does not have, and worse, because it would
/// have made the choice without anybody having asked for one.
///
/// **And it says so when there is nothing to choose.** A machine with no working
/// device, or one whose devices report no encoder this build carries, gets the
/// sentence naming that rather than a button that appears to do nothing — which is
/// the same rule the `-hwaccel` picker follows when nothing can decode the file.
function chooseRows(codec) {
    const choice = chooseFor({ height: settings.height || project.height,
                               videoCodec: codec, inputs });
    const rows = [row('', [
        el('button', {
            cls: 'tiny', 'data-f': 'hwchoose', text: 'Choose for me',
            // The answer before the press as well as after it, because a button
            // whose effect can only be discovered by pressing it is a button
            // nobody presses twice.
            title: choice.why,
            on: { click: () => {
                const answer = chooseFor({ height: settings.height || project.height,
                                           videoCodec: activeVideoCodec(), inputs });
                chosenNote = answer.why;
                // The decode half first: it is the half with no exceptions, and an
                // input reopened without its device has to be put back under
                // whatever is cut from it before anything redraws.
                for (const input of applyChoice(answer))
                    if (hooks.reopened) hooks.reopened(input);
                if (answer.encoder) settings.videoCodec = answer.encoder;
                // `changed` and not `restated`: an encoder is what the picture is
                // spent on, so the candidate render is no longer of these settings.
                hooks.changed();
            } },
        }),
        span(choice.changed
                 ? 'software decode, hardware encode, above SD — the arrangement this machine ' +
                   'was measured in'
                 : 'this render already is what the measurement asks for', 'dim'),
    ])];
    // The sentence stays until the next press. It is about a decision that was
    // taken, and a note that vanished on the next redraw would be a decision nobody
    // could go back and read.
    if (chosenNote) rows.push(row('', span(chosenNote, 'dim ex-chosen')));
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
        // Held, not given an id: `rateRows()` rebuilds this on every draw, and
        // an id on a repeatable element is the thing bro's element index cannot
        // keep straight. Nothing looks it up anyway.
        qualityLabel = span('', 'mono dim');
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
    // `restated`, not `changed`: a title is metadata about the file and not
    // anything about the picture, so it must not throw away a candidate render
    // that cost ten seconds — which is the same division the stream list's
    // language and disposition controls already make. It did neither before,
    // and so reached the spec without the summary or the command bar ever
    // saying so.
    const title = el('input', {
        cls: 'wide', 'data-f': 'title', type: 'text', value: settings.title,
        placeholder: 'written as metadata',
        on: { change: () => { settings.title = title.value; hooks.restated(); } },
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
        ...rawAudioOptionRows(),
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

const FPS_MODES = [
    { v: 'cfr', l: 'Constant', title: 'The range walked at the output rate, each frame '
                                    + 'stamped with its number' },
    { v: 'vfr', l: 'Variable', title: 'The filter graph’s own frame times, kept' },
];

function timingRows() {
    const rows = [];

    // **`-fps_mode` is two values here, and only one of them is ever available.**
    // `cfr` walks the range at the output rate and stamps each frame with its
    // number; `vfr` keeps the frame times libavfilter put on the pictures, which
    // is what makes an `fps`, a `select` or a `framestep` in the graph come out
    // as the rate it made rather than sped up or slowed down by the ratio.
    //
    // The compositor has no such times — it answers for whatever instant it is
    // asked about, and a stack of clips at different rates has no answer to
    // "whose?" — so a render that composites is constant and the control **says
    // so** rather than disappearing. Same for a second picture leaving the graph
    // by a named pad, each of which produces at its own moments. `ffmpeg-bro`'s
    // whole posture is that a refusal names its reason; `pattern_type=glob` on
    // the Write stage is the same shape.
    //
    // `effectiveFpsMode()` is the one home for which of the two is in force —
    // the spec sent to the renderer and the printed command read the same
    // function, so the sentence below cannot come to disagree with the file.
    //
    // `freshSpec()` rather than `currentSpec()`: the memo in spec.js is
    // documented as living for exactly one synchronous answer, and a form drawn
    // from whatever the last `warnings()` walk left in it would be a sentence one
    // edit behind. These rows are only drawn with Advanced open, so the build is
    // paid for by whoever opened it.
    const spec = freshSpec();
    const inForce = effectiveFpsMode(spec);
    const padFed = (spec.streams || []).some((s) => s && s.kind === 'video' &&
                                                    String(s.source || '').startsWith('pad:'));
    const canVary = !!spec.filterGraph && !padFed;
    rows.push(row('Frame timing', btns([
        segmented('fpsmode', FPS_MODES.map(
            (m) => (m.v === 'vfr' && !canVary
                ? Object.assign({}, m, { disabled: true,
                                         title: 'Only a filter graph has frame times of its '
                                              + 'own to keep' })
                : m)), settings.fpsMode,
            (v) => { settings.fpsMode = v; drawForm(); hooks.changed(); }),
        span(`-fps_mode ${inForce}`, 'mono dim'),
    ])));
    rows.push(row('', note(
        canVary
            ? (inForce === 'vfr'
                ? 'The pictures reach the file with the timestamps libavfilter gave them, on ' +
                  'the graph’s own clock — so a rate change inside the graph comes out as ' +
                  'itself. A frame whose timestamp does not advance is dropped, which is what ' +
                  'ffmpeg’s `vfr` means. The range still says where the file ends.'
                : 'The render walks the range at the output rate and stamps each frame with ' +
                  'its number. Variable would keep the graph’s own frame times instead.')
            : (padFed
                ? 'Variable is unavailable because a stream here is fed from a graph pad: ' +
                  'each pad leaves the graph at its own moments, and one walk over the frames ' +
                  'has one timestamp to give. Map the composite, or write the pads as renders ' +
                  'of their own.'
                : 'Variable is unavailable because this render composites the timeline. The ' +
                  'compositor answers for any instant it is asked about, so it has no frame ' +
                  'times of its own to keep — put the rate change in the graph and it does.'))));

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

/// The same column again, for the *audio* encoder.
///
/// `settings.extraAudio` existed, was persisted, and was read on every render
/// by `audioOptions()` — and nothing anywhere wrote to it, so `-c:a libopus`
/// could be given a bitrate and a channel count and nothing else, while its
/// video counterpart had eighty options. Every other bag in this application
/// has a column: the video encoder's here, the muxer's on the Write stage, the
/// demuxer's, the protocol's and the decoder's on Sources. This was the gap.
///
/// Its own search box (`aoptsearch`), because the search term is about *this*
/// list — `opttable.js` keys it by the column's name for exactly that reason,
/// and two columns sharing one would filter each other.
///
/// Drawn only where there is an audio encoder to configure. A render with the
/// sound switched off, or into a container that holds none, has no table to
/// show and an empty column would read as an encoder with no options.
function rawAudioOptionRows() {
    const codec = activeAudioCodec();
    if (!settings.audio || !codec) return [];
    const all = optionsOf(codec);
    if (!all.length) return [];
    return optionColumn({
        name: 'aoptsearch',
        title: `${codec} options · ${all.length}`,
        options: all,
        bag: settings.extraAudio,
        hint: 'Anything set here is passed straight to the audio encoder.',
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
