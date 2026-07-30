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

import { project, isGenerator } from './project.js';
import { argsOf, summaryOf } from './generator.js';
import { el, div, span, put, head } from './dom.js';
import { kindOf, inputs } from './inputs.js';
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
        panel.filename.textContent = 'no media';
        panel.filename.classList.add('dim');
        put(panel.chips, () => []);
        put(panel.transform, () => []);
        return;
    }
    panel.filename.textContent = clip.name;
    panel.filename.classList.remove('dim');
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

/// Every subtitle track this clip could burn in.
function burnable(clip) {
    const out = [];
    const probe = clip.input && clip.input.probe;
    for (const s of (probe && probe.streams) || []) {
        if (s.kind !== 'subtitle') continue;
        out.push({
            label: `${s.index}: ${s.codec}` + (s.language ? ` (${s.language})` : ''),
            note: s.title || '',
            path: clip.input.path, ordinal: subtitleOrdinal(probe, s.index),
            codec: s.codec, can: canBurn(s),
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
            codec: first ? first.codec : '', can: canBurn(first),
        });
    }
    return out;
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
                : el('button', {
                      cls: 'tiny', text: 'Burn in', disabled: true,
                      title: `${track.codec} carries pictures of characters rather than ` +
                             'characters. libavfilter’s subtitles filter is libass and ' +
                             'refuses one by name — so this track can be carried as a ' +
                             'stream on the Write stage, and cannot be drawn into the ' +
                             'picture here.',
                  });
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
