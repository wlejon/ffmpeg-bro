// The right-hand panel, and the chips beside the filename.
//
// It edits the whole selection at once, which is where the care goes: a field
// whose selection disagrees shows blank rather than one clip's value, because
// an inherited number that silently applies to three other clips the moment
// you tab past it is the classic multi-select trap.
//
// What is *in* a file is no longer here. It was the Media half of this panel,
// hanging off the primary selection because a panel about one clip can only
// describe one file; it is the Sources stage now (ui/sources.js), which reads
// every file on the timeline. The chips stay: they are about the clip in front
// of you, which is what the rest of this panel is about.
//
// The panel is rebuilt from the model rather than kept in sync field by field.
// It is a dozen controls, and a panel that can disagree with the picture is
// worse than one that is redrawn.
//
// **Subtitles are here for one reason: this is where a clip is.** Burning a
// track in is a filter node like any other and the Graph stage is where filter
// nodes are placed — but *which* track, out of the three a recording carries,
// is a question about the clip in front of you, and the answer has to be able
// to name a stream index and a path without either being typed. So the button
// is here and what it makes is an ordinary node over there.

import { project, isGenerator, speedOf, setSpeed,
         SPEED_MIN, SPEED_MAX } from './project.js';
import { argsOf, summaryOf } from './generator.js';
import { el, div, span, put, head } from './dom.js';
import { kindOf, inputs, streamKinds } from './inputs.js';
import * as graph from './graph/overlay.js';
import { canBurn, subtitleOrdinal, burnParams, burnAnchor } from './export/subtitles.js';

let panel = {};
let hooks = {};

export function initInspector(refs, h) {
    panel = refs;
    hooks = h || {};
}

// ── what is selected ───────────────────────────────────────────────────────

/// Every clip an edit applies to: the whole selection, or the primary alone if
/// somehow nothing is selected. Exported because dragging the picture is an
/// edit to the same set, and there should be one answer to what "the same set"
/// means.
export function subjects() {
    return project.selection.length ? project.selection
         : project.selected ? [project.selected] : [];
}

/// Read a property across the selection. Returns the value when they agree and
/// `undefined` when they do not — which is what a field showing "—" means, and
/// what stops a panel from quietly claiming four clips are all at 100%.
function common(read) {
    const list = subjects();
    if (!list.length) return undefined;
    const first = read(list[0]);
    for (const c of list) if (read(c) !== first) return undefined;
    return first;
}

/// Write a property to every selected clip and put the picture back in step.
function edit(write) {
    for (const c of subjects()) write(c);
    hooks.edited();
}

// ── the whole panel ────────────────────────────────────────────────────────

export function showProperties() {
    const clip = project.selected;
    if (!clip) {
        if (panel.filename) {
            panel.filename.textContent = 'no media';
            panel.filename.classList.add('dim');
        }
        put(panel.chips, () => []);
        put(panel.transform, () => []);
        return;
    }
    if (panel.filename) {
        panel.filename.textContent = clip.name;
        panel.filename.classList.remove('dim');
    }
    showChips(clip.probe);
    showTransform(clip);
}

// ── the chips, in the title bar ────────────────────────────────────────────

function showChips(p) {
    const chip = (text, hot) => span(String(text), 'chip' + (hot ? ' hot' : ''));
    put(panel.chips, () => [
        chip(p.format.name.split(',')[0], true),
        p.video && chip(`${p.video.displayWidth}×${p.video.displayHeight}`),
        p.video && chip(p.video.codec),
        p.video && p.video.fps && chip(p.video.fps.toFixed(3) + ' fps'),
        p.audio && chip(`${p.audio.codec} ${p.audio.channels}ch`),
    ]);
}

// ── the transform panel ────────────────────────────────────────────────────

/// Which of this panel's controls have been outranked by a lock on the graph.
///
/// A value typed into a node beats what the timeline says — that is what a lock
/// is for — and the failure worth designing against is that happening quietly.
/// So the field that has stopped applying says so *here*, where someone is
/// about to drag it, and not only on a stage they may not have open.
function outranked() {
    const by = hooks.outranked ? hooks.outranked() : {};
    const out = new Set();
    for (const c of subjects())
        for (const name of by[String(c.id)] || []) out.add(name);
    return out;
}

export function showTransform(clip) {
    if (!clip) return put(panel.transform, () => []);
    const list = subjects();
    const many = list.length > 1;
    const gridOn = project.layout === 'grid';
    const again = () => showTransform(clip);
    const locked = outranked();
    const mark = (name) => (locked.has(name) ? name : null);

    put(panel.transform, () => [
        head('Canvas'),
        controlRow('Size', canvasSize()),
        controlRow('Preset', evenButtons([
            ['Match clip', () => resizeCanvas(clip.width, clip.height, again)],
            ['1080p', () => resizeCanvas(1920, 1080, again)],
        ])),
        controlRow('', evenButtons([
            ['Vertical', () => resizeCanvas(1080, 1920, again)],
            ['4K', () => resizeCanvas(3840, 2160, again)],
        ])),
        controlRow('Layout', div('seg', [
            toggleButton('Stack', !gridOn, () => hooks.setLayout('stack')),
            toggleButton('Grid', gridOn, () => hooks.setLayout('grid')),
        ])),

        head(many ? `Properties · ${list.length} clips` : `Properties · ${clip.name}`),
        controlRow('Track', div('btns', [
            el('button', { cls: 'tiny', text: 'Down', 'data-track': -1,
                           on: { click: () => nudgeTrack(-1) } }),
            el('button', { cls: 'tiny', text: 'Up', 'data-track': 1,
                           on: { click: () => nudgeTrack(1) } }),
            span(common((k) => k.track) === undefined ? 'mixed' : 'V' + (clip.track + 1), 'mono dim'),
        ])),
        controlRow('Opacity', percentSlider('opacity',
            common((k) => k.xform.opacity),
            (f) => { for (const k of subjects()) k.xform.opacity = f; }), mark('opacity')),
        ...speedRows(again),
        controlRow('Audio', div('btns', [
            toggleButton('Mute', common((k) => k.muted) === true, () => {
                const on = !(common((k) => k.muted) === true);
                for (const k of subjects()) k.muted = on;
                hooks.audioChanged();
                again();
            }, 'data-mute'),
            slider('clipvol', Math.round((common((k) => k.volume) ?? 1) * 100), (f) => {
                for (const k of subjects()) { k.volume = f; if (f > 0) k.muted = false; }
                hooks.audioChanged();
            }),
        ]), mark('volume')),

        head(gridOn ? 'Transform (grid: cell-relative)' : 'Transform'),
        controlRow('Fit', div('seg', ['contain', 'cover', 'stretch', 'actual'].map((id, i) =>
            el('button', {
                cls: 'tiny' + (common((k) => k.xform.fit) === id ? ' on' : ''),
                text: ['Fit', 'Fill', 'Stretch', '1:1'][i],
                'data-fit': id,
                on: { click: () => { edit((k) => { k.xform.fit = id; }); again(); } },
            })))),
        controlRow('Scale', percentSlider('zoom', common((k) => k.xform.zoom),
            (f) => { for (const k of subjects()) k.xform.zoom = Math.max(0.05, f); },
            5, 400), mark('size')),
        controlRow('Position', div('btns', [
            span(many ? '—' : `${pc(clip.xform.panX)}%, ${pc(clip.xform.panY)}%`, 'mono dim'),
            el('button', { cls: 'tiny', text: 'Reset', 'data-reset': 'pan',
                           on: { click: () => {
                               edit((k) => { k.xform.panX = k.xform.panY = 0; k.xform.zoom = 1; });
                               again();
                           } } }),
        ]), mark('position')),

        ...generatorRows(clip, again),
        ...subtitleRows(clip, again),

        head('Crop'),
        controlRow('Left / Top', div('btns', [cropField('l'), cropField('t')]), mark('crop')),
        controlRow('Right / Bot', div('btns', [cropField('r'), cropField('b')]), mark('crop')),
        controlRow('', div('btns', [
            toggleButton('Handles (C)', hooks.cropHandlesOn(), () => hooks.toggleCropHandles(),
                         'data-crop'),
            el('button', { cls: 'tiny', text: 'Reset', 'data-reset': 'crop',
                           on: { click: () => {
                               edit((k) => { k.xform.crop = { l: 0, t: 0, r: 0, b: 0 }; });
                               again();
                           } } }),
        ])),
    ]);
}

const pc = (v) => (v * 100).toFixed(1);

// ── how fast the clip runs ─────────────────────────────────────────────────
//
// Four presets and a field, and the field is the control: a speed is one number
// and `2` is what somebody would have typed after `setpts=PTS/`. The presets are
// there because half, double and quarter are most of what anybody asks for and a
// press beats four keystrokes.
//
// **The sentence under it is not a disclaimer, it is the offer.** A speed here
// resamples, so the pitch moves with it — that is the decision `ui/project.js`'s
// speed section argues, and the reason is that the compositor has no filter graph
// to put an `atempo` in and the two paths must describe one render. What a person
// can do about it is real and one stage away, so the line names `atempo` rather
// than apologising. The same rule the Graph stage's refusals follow: say the reason
// and say what to reach for.
//
// A refusal — reverse, or a freeze — comes back from `setSpeed()` as words and is
// shown here, where the hand is. Not a `flash`: the field is still on screen with
// the number that was rejected in it, and a message that floats away leaves
// somebody looking at a value that did not take.

const SPEED_PRESETS = [0.25, 0.5, 1, 2];

function speedRows(again) {
    const value = common((k) => speedOf(k));
    const mixed = value === undefined;
    let said = '';

    const set = (v) => {
        // Per clip, because the clamp is per clip: a speed decrease grows a bar
        // and what stops it is *its own* neighbour. One selection can therefore
        // come out at two lengths, which is the honest answer and the same one a
        // multi-clip trim gives.
        said = '';
        for (const k of subjects()) said = setSpeed(k, v) || said;
        hooks.audioChanged();
        hooks.moved();
        again();
        if (said) sayIt(said);
    };

    const field = el('input', {
        cls: 'num' + (mixed ? ' mixed' : ''), type: 'number',
        value: mixed ? '' : +value.toFixed(3), placeholder: '—',
        min: SPEED_MIN, max: SPEED_MAX, step: 0.05, 'data-speed': 'x',
        title: 'How fast this clip runs — 2 is twice as fast in half the timeline, ' +
               'over the same footage. The pitch moves with it.',
    });
    field.addEventListener('change', () => {
        if (field.value === '') return;             // still mixed, left alone
        set(Number(field.value));
    });

    const chip = span('pitch follows speed', 'gp-badge');
    const keepPitchBtn = el('button', {
        cls: 'tiny', text: 'Keep pitch',
        on: { click: () => {
            if (hooks.addFilter) hooks.addFilter('atempo');
        } }
    });
    const speedInfo = div('gp-speed-info', [chip, keepPitchBtn]);

    return [
        controlRow('Speed', div('btns', [
            field,
            span('×', 'dim'),
            ...SPEED_PRESETS.map((v) => el('button', {
                cls: 'tiny' + (!mixed && Math.abs(value - v) < 1e-6 ? ' on' : ''),
                text: v === 1 ? '1×' : `${v}×`, 'data-speed-preset': String(v),
                on: { click: () => set(v) },
            })),
        ])),
        controlRow('', speedInfo),
    ];
}

// ── the generator this clip is of ──────────────────────────────────────────
//
// **One text field, and not a form of controls**, which is a departure from the
// rest of this panel and is the honest shape for it. A generator's options are
// the *filter's* own — `size` and `rate` on a `testsrc`, `c` on a `color`, a
// dozen on `mandelbrot` — and libavfilter has five hundred filters with tables
// of their own. The Graph stage already draws that form, per option, out of
// `filterOptions()`; what belongs on the timeline is the one line somebody would
// have typed after `-f lavfi -i`, exact and copyable, with the node a stage away
// for the rest. It is the same distinction the command bar draws between a
// control and the argument it produces.
//
// A wrong option is refused in libavfilter's own words and nothing changes — the
// clip keeps the arguments it had, because "an unknown option is an error, not a
// shrug" and a field that quietly dropped what it could not parse would be a
// generator that is not the one on the screen.

/// The arguments of the selected generator, where exactly one is selected.
///
/// **A selection of one**, and that is not timidity: the arguments belong to this
/// filter, and a selection can hold two generators that are not the same filter
/// at all — a field writing `size=` into both would be writing an option one of
/// them does not have, which is a refusal on a clip nobody was looking at. Same
/// argument as `subtitleRows` above, one step stronger.
function generatorRows(clip, again) {
    if (!isGenerator(clip) || subjects().length > 1) return [];
    const field = el('input', {
        cls: 'gen-args', type: 'text', value: argsOf(clip.generator),
        placeholder: 'no arguments',
        'data-gen-args': clip.generator.filter,
        title: 'What follows the filter name, exactly as ffmpeg takes it — ' +
               'key=value pairs separated by colons. Every option this build’s ' +
               `${clip.generator.filter} has is on its card on the Graph stage; ` +
               'an option it does not have is refused here in libavfilter’s own words.',
    });
    field.addEventListener('change', () => {
        hooks.setGeneratorArgs(clip, field.value);
        again();
    });
    return [
        // Named, always, for the reason the subtitle heading is: this section is
        // about the clip in front of you and not about the selection.
        head(`Generator · ${clip.generator.filter}`),
        controlRow('Arguments', div('val', [field])),
        ...(summaryOf(clip.generator.filter)
                ? [controlRow('', span(summaryOf(clip.generator.filter), 'dim'))] : []),
    ];
}

// ── subtitles, burned into this clip ───────────────────────────────────────
//
// Three decisions, and they are the whole of why this took a control rather
// than a checkbox.
//
// **Whose track.** A recording carries three of them and the graph node has to
// name one — `si=`, which counts *subtitle* streams and not streams, so the
// second subtitle track of a file whose streams run video, audio, subtitle,
// subtitle is `si=1` and never `si=3`. Every track the clip's own input carries
// gets a row, named the way the Sources stage names it.
//
// **A control to turn it on**, because burning them into the picture and
// writing them beside it are two different statements about the finished file
// and nothing should choose between them for you. This one makes them part of
// the picture; the Write stage's `+ Subtitle` writes them as a track a player
// can switch off; a file can have both and they do not know about each other.
//
// **A track that came from a separate file** is offered here too, against the
// clip it belongs to — an `.srt` next to `interview.mp4` is timed against
// *interview.mp4*, which is the clock the burn-in point runs on. A file of cues
// written for the finished programme is the other case, and it has the other
// home: `Burn it into the picture` on the Sources stage puts it over the whole
// canvas. Which of the two somebody has is not something either stage can ask
// the file, so both doors exist and each says what it is for.
//
// What it places is an ordinary node — printed by the command bar, movable and
// deletable on the Graph stage — and unlike the Sources stage's button this one
// does not take you there, because the point of it is that the picture in front
// of you changes.
//
// **A track of pictures gets the other button, and it places three nodes.**
// `dvdsub` and `hdmv_pgs_subtitle` are bitmaps: libass cannot draw them and there
// is no OCR here, so `Burn in` is not what they need and used to be a disabled
// button with an explanation. What they need is an `overlay` fed from the input's
// own subtitle pad — `[0:s]`, painted cue by cue, which is ffmpeg's own sub2video
// and is `export_sub2video.h` here — and that is one press: `Draw cues`. The
// picture in front of you does *not* change for this one, because the viewer
// plays one chain of one input and this is two; `O` plays the render, which is
// where they are.

/// Every subtitle track this clip could burn in — or, where it is pictures of
/// characters, draw.
///
/// `input` travels with each row because the *drawn* half needs the `-i` and not
/// only its path: cues are drawn by placing that input as a node of the graph and
/// wiring its subtitle pad, which is a thing you can only do to an input the
/// document holds.
function burnable(clip) {
    const out = [];
    const probe = clip.input && clip.input.probe;
    for (const s of (probe && probe.streams) || []) {
        if (s.kind !== 'subtitle') continue;
        out.push({
            label: `${s.index}: ${s.codec}` + (s.language ? ` (${s.language})` : ''),
            note: s.title || '',
            path: clip.input.path, ordinal: subtitleOrdinal(probe, s.index),
            codec: s.codec, can: canBurn(s), input: clip.input,
        });
    }
    // Every file of cues open on the Sources stage, whatever it was opened for.
    // Not filtered to the ones whose name looks like this clip's: a subtitle
    // file is routinely named nothing like the video, and a list that guessed
    // would hide the right answer more often than it saved a row.
    for (const input of inputs) {
        if (input === clip.input || kindOf(input) !== 'subtitles') continue;
        const first = ((input.probe && input.probe.streams) || [])[0];
        out.push({
            label: input.name, note: first ? first.codec : '',
            path: input.path, ordinal: 0,
            codec: first ? first.codec : '', can: canBurn(first), input,
        });
    }
    return out;
}

/// The nodes drawing this bitmap track over this clip, or null.
///
/// Read out of the overlay rather than remembered anywhere, for the reason
/// `burnedIn` is: the nodes are the fact, and deleting one of them on the Graph
/// stage has to bring this button back up. Recognised by its *shape* — an
/// `overlay` at this clip's own point whose second input is fed by a node reading
/// this input — so a graph somebody built by hand is recognised as the same
/// thing, which is the difference between a button and a mode.
function drawnOn(clip, track) {
    const anchor = burnAnchor(clip.id);
    for (const rec of graph.inserts()) {
        if (rec.anchor !== anchor || rec.filter !== 'overlay') continue;
        const fed = graph.wires().find((w) => w.to === rec.id && (w.port || 0) === 1);
        const source = fed && graph.nodes().find(
            (n) => n.id === fed.from && n.kind === 'input' &&
                   String(n.input) === String(track.input && track.input.id));
        if (source) return { over: rec, source };
    }
    return null;
}

/// Cues that are pictures, **drawn** — the other half of `Burn in`, and the only
/// half a `dvdsub` or `hdmv_pgs_subtitle` track has.
///
/// Three nodes rather than one, because drawing a picture over a picture is an
/// `overlay`: the input as a source node of the graph, an `overlay` spliced onto
/// this clip's own chain, and the wire from the input's subtitle pad to the
/// overlay's second input. That is the graph a person would build by hand, it is
/// what the command bar prints, and every one of the three can be moved,
/// configured and deleted on the Graph stage.
///
/// **The clock is why it goes on this clip's chain** rather than over the whole
/// canvas: a track inside a file is timed against *that file*, which is the clock
/// above the derivation's `setpts` — the same argument `burnAnchor` is written
/// for. It is also the clip's own size, which is the size the cues were authored
/// against.
///
/// **A second `-i` of the same file, deliberately.** A graph's input node is an
/// `-i` in this model and the clip's own input node carries pads only for what
/// the derivation reads. Teaching the derivation to grow a third pad on demand
/// would mean the overlay's wires naming a port whose index moves the moment the
/// clip is muted — a wire that silently points at another stream — so the honest
/// arrangement is the one ffmpeg would print: the file opened twice, once for the
/// picture and once for the cues.
function drawCues(clip, track, port) {
    const over = graph.insert(burnAnchor(clip.id), 'overlay');
    const source = graph.addSource(track.input.id);
    graph.wire(source.id, port, over.id, 1, 's');
}

/// The node burning this track into this clip, or null.
///
/// Read out of the overlay rather than remembered on the clip, because the node
/// is the fact: delete it on the Graph stage and this button has to come back
/// up. Matched on what it *says* — the filename and the stream — so a node
/// somebody typed by hand at the same point is recognised as the same thing,
/// which is the difference between a button and a mode.
function burnedIn(clip, track) {
    const anchor = burnAnchor(clip.id);
    const want = burnParams(track.path, track.ordinal);
    return graph.inserts().find((rec) => {
        if (rec.anchor !== anchor || rec.filter !== 'subtitles') return false;
        const p = rec.params || {};
        return p.filename === want.filename && String(p.si || '0') === String(want.si || '0');
    }) || null;
}

/// What a track of pictures gets instead of `Burn in`.
///
/// **libass reads characters, and these cues are not characters** — so the
/// filter that burns text in refuses this track by name, and the answer is the
/// graph: an `overlay` fed from the input's own subtitle pad, which is
/// `[0:s]` and is drawn by painting the bitmaps the track carries. See
/// `drawCues` for what is placed and `export_sub2video.h` for what draws it.
///
/// Disabled with the reason only where the input has **no cues pad at all**,
/// which is a file `probe()` could read no subtitle stream out of — `streamKinds`
/// grows the pad off the probe, so no pad means there is nothing a graph could
/// read either. It is not the ordinary state of anything and it is a button
/// rather than a missing row because a row that vanished would say nothing.
function drawButton(clip, track, again) {
    const port = streamKinds(track.input).indexOf('s');
    if (port < 0)
        return el('button', {
            cls: 'tiny', text: 'Draw cues', disabled: true,
            title: `${track.codec || 'this track'} is pictures of characters rather than ` +
                   'characters, so libass cannot draw it — and this input has no pad of cues ' +
                   'to draw from either, which is a file nothing could read a subtitle ' +
                   'stream out of. It can still be carried as a stream on the Write stage.',
        });
    const drawn = drawnOn(clip, track);
    const button = toggleButton(drawn ? 'Cues drawn' : 'Draw cues', !!drawn, () => {
        if (drawn) {
            graph.removeInsert(drawn.over.id);
            graph.removeInsert(drawn.source.id);
        } else drawCues(clip, track, port);
        again();
    }, 'data-draw');
    button.setAttribute('title',
        `${track.codec} is pictures of characters, so libavfilter’s subtitles filter — ` +
        'which is libass — refuses it by name. What draws it is an overlay fed from this ' +
        'input’s own subtitle pad, on this clip’s chain and on the file’s own clock. ' +
        'Three ordinary nodes go on the Graph stage; the viewer cannot play an overlay ' +
        'of two inputs, so press O to watch the render itself.');
    return button;
}

function subtitleRows(clip, again) {
    const list = burnable(clip);
    if (!list.length) return [];
    return [
        // Named, and always: this is the one section on the panel that edits the
        // primary clip rather than the selection, because a track belongs to a
        // file and four selected clips are four files. A heading that said only
        // "Subtitles" over a multi-selection would be the trap the top of this
        // file is about.
        head(`Subtitles · ${clip.name}`),
        ...list.map((track) => {
            const rec = burnedIn(clip, track);
            const button = track.can
                ? toggleButton(rec ? 'Burned in' : 'Burn in', !!rec, () => {
                      if (rec) graph.removeInsert(rec.id);
                      else graph.insert(burnAnchor(clip.id), 'subtitles',
                                        { params: burnParams(track.path, track.ordinal) });
                      again();
                  }, 'data-burn')
                : drawButton(clip, track, again);
            return controlRow(track.label, div('btns', [
                span(track.note, 'mono dim'),
                button,
            ]));
        }),
    ];
}

/// `outrankedBy` names the graph control that has taken this row's job, or is
/// null. The row still works — the value goes into the model and the viewer
/// still shows it — it just no longer reaches the render, and saying which node
/// took it is the difference between an explanation and a mystery.
function controlRow(key, control, outrankedBy) {
    const node = div('row' + (outrankedBy ? ' outranked' : ''), [span(key, 'key'), control]);
    if (outrankedBy) {
        node.setAttribute('data-outranked', outrankedBy);
        node.title = `Locked in the graph — this no longer reaches the render. ` +
                     `Unlock the ${outrankedBy} node on the Graph stage to hand it back.`;
    }
    return node;
}

/// A cluster whose buttons share the row evenly. `.val` as well, because it is
/// still the right-hand half of a labelled row.
const evenButtons = (pairs) => div('val btns even', pairs.map(([label, onClick]) =>
    el('button', { cls: 'tiny', text: label, 'data-canvas': label, on: { click: onClick } })));

function toggleButton(label, on, onClick, hook) {
    const opts = { cls: 'tiny' + (on ? ' on' : ''), text: label, on: { click: onClick } };
    if (hook) opts[hook] = '1';
    return el('button', opts);
}

function canvasSize() {
    const w = sizeField(project.width);
    const h = sizeField(project.height);
    const apply = () => {
        const nw = Number(w.value), nh = Number(h.value);
        if (nw >= 16 && nh >= 16) {
            project.width = nw; project.height = nh;
            hooks.canvasResized();
        }
    };
    w.addEventListener('change', apply);
    h.addEventListener('change', apply);
    return div('val btns', [w, span('×', 'dim'), h]);
}

const sizeField = (value) =>
    el('input', { cls: 'num', type: 'number', value, min: 16, max: 16384 });

function resizeCanvas(w, h, again) {
    project.width = w;
    project.height = h;
    hooks.canvasResized();
    again();
}

function nudgeTrack(d) {
    edit((k) => { k.track = Math.max(0, Math.min(7, k.track + d)); });
    hooks.moved();
}

/// Sliders write on every input event, so they only ever update their own
/// readout: rebuilding the panel mid-drag would replace the slider under the
/// pointer and the drag would end there.
function slider(name, value, apply) {
    const node = el('input', { type: 'range', min: 0, max: 100, value, 'data-s': name });
    node.addEventListener('input', () => {
        apply(Number(node.value) / 100);
        hooks.redraw();
    });
    return node;
}

function percentSlider(name, value, apply, min = 0, max = 100) {
    const mixed = value === undefined;
    const readout = span(mixed ? '—' : `${Math.round(value * 100)}%`, 'mono dim');
    const node = el('input', { type: 'range', min, max,
                               value: Math.round((mixed ? 1 : value) * 100), 'data-s': name });
    node.addEventListener('input', () => {
        const f = Number(node.value) / 100;
        apply(f);
        readout.textContent = `${Math.round(f * 100)}%`;
        hooks.redraw();
    });
    return div('btns', [node, readout]);
}

/// A crop edge, in per cent. Blank when the selection disagrees — and a blank
/// left blank changes nothing, which is the point.
function cropField(edge) {
    const v = common((k) => +pc(k.xform.crop[edge]));
    const node = el('input', {
        cls: 'num' + (v === undefined ? ' mixed' : ''), type: 'number',
        value: v === undefined ? '' : v, min: 0, max: 95, step: 0.5, placeholder: '—',
        'data-crop-edge': edge,
    });
    node.addEventListener('change', () => {
        if (node.value === '') return;              // still mixed, left alone
        const f = Math.max(0, Math.min(0.95, Number(node.value) / 100));
        edit((k) => { k.xform.crop[edge] = f; });
    });
    return node;
}
