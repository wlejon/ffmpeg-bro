// One node, as a node editor draws one.
//
// This used to be twenty lines inside `view.js` and it was ours rather than the
// world's: a bordered box with the arguments listed as text, wires arriving at a
// bare edge, and nothing to grab. Node editors are a solved interface — Blender,
// Nuke, Houdini, TouchDesigner, Unreal, n8n, Node-RED and React Flow all agree on
// the same handful of things — and the point of this file is to stop inventing.
// Four of those things are structural:
//
// - **A header, and it is the handle.** The name is in the UI font at the panel's
//   own base size, not in mono at ten pixels, because it is a name and not a
//   value. Dragging it moves the node; dragging anything else does not, so a
//   field can be dragged through without the card coming with it.
// - **Sockets, one per port, on the edge.** Drawn at `portY()` — the same
//   function `layout.js` uses to decide where the wire lands — because a dot
//   anywhere else would say this wire goes to that port when it does not. Which
//   is a claim `overlay` in particular cannot afford: its two inputs are the
//   canvas and the clip, in that order, and they are not interchangeable.
// - **Values are edited here.** A `<select>` where libavfilter's option table has
//   constants and an `<input>` where it does not — the same choice `panel.js`
//   makes, from the same table, through `filters.js` so there is one cache and one
//   answer. Reading a value and changing it in two different places is how you get
//   a screen you have to look away from to use.
// - **A level of detail.** Below a certain zoom the body is not built at all. A
//   nine-node graph at 0.4× with every argument drawn is nine grey smudges; the
//   same graph with nine legible names is a graph.
//
// Three things about editing here that are not obvious and each of which breaks
// it if missed. An edit locks the node, a lock redraws the graph, and a redraw
// throws away every card — so: **commit on `change`, never on `input`**, or the
// field vanishes between keystrokes; **restore focus afterwards**, because a
// `<select>` fires `change` while it still has focus and would otherwise lose it
// mid-gesture; and **stop `mousedown` propagating out of a control**, or dragging
// a slider drags the node.

import { el, div, span } from '../dom.js';
import { basename } from '../format.js';
import { portY } from './layout.js';
import { optionOf } from './filters.js';
import * as overlay from './overlay.js';
import * as preview from './preview.js';

/// Below this zoom a card is its header and its picture. Chosen because 11px
/// argument text stops being text at about 0.6 of it, and because the pictures
/// are the one thing that still reads when small — Blender keeps its previews and
/// hides its sockets for the same reason.
export const LOD_ZOOM = 0.6;

let hooks = {};

/// `{ onSelect, onDragStart, onResizeStart, onChanged }`.
export function initCards(h) { hooks = h || {}; }

// ── the players ────────────────────────────────────────────────────────────
//
// Held by node key across every rebuild. A `<video>` made fresh each time would
// reload and restart, so a graph filling in one preview at a time would restart
// the other eight over and over and none would get past its first second.
//
// Two of them for the node being played, because a playback is a run of separate
// files and `src = next` is a reload: the picture goes black and decoding starts
// from nothing, which at one piece every couple of seconds is a blink often enough
// to be the thing you watch instead of the filter. The second is made when play is
// pressed and dropped when it stops — eighteen decoders for nine cards, all but two
// of them showing a still, would be paying everywhere to spend it in one place.

const videos = new Map();

export function pairOf(key) { return videos.get(key) || null; }

function pairFor(key) {
    let p = videos.get(key);
    if (!p) { p = { a: newVideo(), b: null, front: 'a', playing: '' }; videos.set(key, p); }
    if (preview.isPlaying(key)) {
        if (!p.b) p.b = newVideo();
    } else if (p.b) {
        release(p.b);
        p.b = null;
        p.front = 'a';
        p.playing = '';
    }
    return p;
}

function newVideo() {
    const v = document.createElement('video');
    v.muted = true;
    return v;
}

export function release(v) {
    try { v.pause(); v.src = ''; } catch (e) { /* already gone */ }
    v.__path = '';
}

/// A card that has gone takes its decoders with it. Left behind, every node ever
/// previewed would still be decoding.
export function dropUnless(alive) {
    for (const [key, pair] of Array.from(videos)) {
        if (alive(key)) continue;
        release(pair.a);
        if (pair.b) release(pair.b);
        videos.delete(key);
    }
}

// ── focus across a redraw ──────────────────────────────────────────────────
//
// The one field that was being used, remembered by what it is rather than by
// which element it was: the element is gone by the time this matters.

let wanted = null;

function wantFocus(key, name) { wanted = { key, name }; }

export function restoreFocus(root) {
    if (!wanted || !root) return;
    const { key, name } = wanted;
    wanted = null;
    const node = root.querySelector(`[data-key="${key}"] [data-f-name="${name}"]`);
    if (node && node.focus) { try { node.focus(); } catch (e) { /* not focusable here */ } }
}

// ── the card ───────────────────────────────────────────────────────────────

/// `ctx` is `{ graph, key, width, lod }`. Returns the element; `view.js` places
/// it, and `placeSockets()` finishes it once the height is known.
export function buildCard(n, ctx) {
    const { graph: g, key, width, lod } = ctx;
    const cls = ['gn', `gn-${n.kind}`];
    if (n.locked) cls.push('gn-locked');
    if (!n.derived) cls.push('gn-user');
    if (n.pinned) cls.push('gn-pinned');

    const node = el('div', {
        cls: cls.join(' '),
        'data-node': n.id,
        'data-key': key || '',
        'data-filter': n.filter || n.kind,
        title: n.path || undefined,
        style: { width: `${width}px` },
        // Ctrl or shift adds to the selection, which is what every editor does and
        // what makes dragging four nodes at once possible.
        on: { click: (e) => hooks.onSelect && hooks.onSelect(key, e.ctrlKey || e.shiftKey) },
    }, [
        header(n, g, key),
        lod === 'min' ? null : body(n),
        shotView(key, width),
        sockets(n, g),
        grip(key, width),
    ]);
    return node;
}

/// The name, what stream it is on, and the pad it produces. The pad is here
/// because it is what the chain in the command bar says, and this screen is worth
/// nothing if the two cannot be read against each other. A sink has no pad of its
/// own and reports the one it maps, which is the same answer `print()` gives
/// `-map`.
function header(n, g, key) {
    const name = n.kind === 'input' ? basename(n.path)
               : n.kind === 'sink' ? (n.stream === 'a' ? 'audio out' : 'video out')
               : n.filter;
    const mapped = n.kind === 'sink' && g.producers(n)[0];
    // A file produces one pad per stream it is read for, so it states all of
    // them: `[0:v] [0:a]` is what the chains in the command bar say, and this
    // screen is worth nothing if the two cannot be read against each other.
    const pad = n.kind === 'input'
                ? (n.outs || [{ stream: n.stream || 'v' }])
                      .map((o) => `[${n.index}:${o.stream}]`).join(' ')
              : mapped && mapped.label ? `[${mapped.label}]`
              : n.label ? `[${n.label}]` : '';

    return el('div', {
        cls: 'gn-head',
        'data-drag': key || '',
        on: { mousedown: (e) => hooks.onDragStart && hooks.onDragStart(key, e) },
    }, [
        span('', 'gn-dot'),
        span(name, 'gn-name'),
        n.locked ? span('●', 'gn-lock') : null,
        pad ? span(pad, 'gn-pad mono') : null,
    ]);
}

/// What the filter is configured with, editable.
///
/// Positional arguments first and in order, because that is the order ffmpeg
/// reads them in and the order they are printed in. Their labels come from the
/// derivation's `posNames` rather than from the option table's ordering: ffmpeg
/// carries aliases as separate entries, so the n-th option is not the n-th
/// positional argument.
function body(n) {
    if (n.kind !== 'filter') return null;
    const rows = [];
    const names = n.posNames || [];
    n.pos.forEach((v, i) => {
        const label = names[i] || `#${i + 1}`;
        rows.push(paramRow(n, label, String(v), `pos:${i}`, (next) => {
            const pos = n.pos.slice();
            pos[i] = next || String(v);       // a blank positional is a parse error
            overlay.edit(n, { pos });
        }));
    });
    for (const k of Object.keys(n.params))
        rows.push(paramRow(n, k, String(n.params[k]), k,
                           (next) => overlay.edit(n, { params: { [k]: next } })));
    return rows.length ? div('gn-body', rows) : null;
}

/// One `label  control` line. The label is the UI font because it is a word and
/// the control is mono because it is a value — which is the distinction the old
/// card, all in mono, could not make.
function paramRow(n, label, value, name, commit) {
    const o = optionOf(n.filter, label);
    const control = o && o.values && o.values.length
        ? enumControl(o, value)
        : el('input', { cls: 'gn-f mono', type: 'text', value });

    control.setAttribute('data-f-name', name);
    if (name.indexOf('pos:') !== 0) control.setAttribute('data-opt', name);
    // `change`, not `input`: an edit locks the node and redraws the graph, and
    // rebuilding the field between keystrokes would take the caret with it.
    control.addEventListener('change', () => {
        wantFocus(hooks.keyOf ? hooks.keyOf(n) : '', name);
        commit(String(control.value).trim());
        if (hooks.onChanged) hooks.onChanged();
    });
    // Otherwise using the control drags the node it is on.
    control.addEventListener('mousedown', (e) => e.stopPropagation());

    return div('gn-row', [span(label, 'gn-k'), control]);
}

function enumControl(o, value) {
    const control = el('select', { cls: 'gn-f mono' },
        [{ v: '', l: `default (${o.default})` }, ...o.values.map((c) => ({ v: c.name, l: c.name }))]
            .map((c) => el('option', { value: c.v, text: c.l, selected: c.v === value })));
    control.value = value;
    return control;
}

// ── sockets ────────────────────────────────────────────────────────────────

/// A dot per port, on both edges. Their vertical positions are not known here —
/// a node is as tall as what is in it and the height arrives from the
/// measurement — so they carry their port number and `placeSockets()` finishes
/// them.
///
/// An input node has an output per stream it is read for, and each of them is
/// coloured by that stream: a file's picture and its sound leave one card, and
/// two identical dots would say the two wires were interchangeable when the
/// whole point of drawing a file as one node is that they come from one `-i`
/// and are not the same pad.
function sockets(n, g) {
    const ins = g.producers(n).length;
    const outs = n.kind === 'sink' ? [] : (n.outs && n.outs.length ? n.outs : [{}]);
    const out = [];
    for (let i = 0; i < ins; i++)
        out.push(el('span', { cls: 'gn-sock gn-sock-in', 'data-port': String(i),
                              'data-ports': String(ins) }));
    outs.forEach((o, i) => {
        out.push(el('span', {
            cls: 'gn-sock gn-sock-out' + (o.stream ? ` gn-sock-${o.stream}` : ''),
            'data-port': String(i), 'data-ports': String(outs.length),
            title: n.kind === 'input' && o.stream ? `${n.index}:${o.stream}` : undefined,
        }));
    });
    return out;
}

/// Once the card has been measured and placed, put every socket where its wire
/// will land. `portY` is the same function `layout.js` computed the wire with,
/// on both edges — a dot anywhere else says this wire goes to that pad when it
/// does not.
export function placeSockets(node, h) {
    for (const s of node.querySelectorAll('.gn-sock')) {
        const port = Number(s.getAttribute('data-port')) || 0;
        const ports = Number(s.getAttribute('data-ports')) || 1;
        s.style.top = `${Math.round(portY(h, port, ports)) - 4}px`;
    }
}

// ── the picture ────────────────────────────────────────────────────────────

/// The looping couple of seconds a card shows when it is not being played.
function showStill(pair, path) {
    const v = pair.a;
    v.classList.remove('gn-off');
    v.loop = true;
    if (v.__path === path) return;
    v.__path = path;
    v.src = path;
    try { v.play(); } catch (e) { /* it will play when it can */ }
}

/// The box keeps its height while a render is outstanding, guessed at 16:9,
/// because a card that grows when its picture arrives shoves every card below it
/// down the screen — and with nine of them arriving one at a time that is nine
/// jumps.
function shotView(key, width) {
    if (!preview.isEnabled() || !key) return null;
    const shot = preview.shotFor(key);
    if (!shot) return null;
    const inner = Math.max(16, width - 12);
    // A node that is playing keeps its picture even when its *still* has been
    // invalidated — an edit elsewhere in the graph can do that, and taking the
    // elements out of the tree would leave the playback running somewhere nobody
    // can see it.
    if (preview.isPlaying(key) || (shot.state === 'ready' && shot.w > 0)) {
        const box = div('gn-shot');
        box.style.height = `${Math.round(inner * (shot.w > 0 ? shot.h / shot.w : 9 / 16))}px`;
        const pair = pairFor(key);
        box.append(pair.a);
        if (pair.b) box.append(pair.b);
        // Left alone while it is playing: the frame loop owns which element is in
        // front and what is in it, and putting the still back on every redraw
        // would jump the picture to the beginning of the range whenever anything
        // on this screen changed.
        if (!preview.isPlaying(key)) showStill(pair, shot.path);
        box.append(playButton(key));
        if (preview.isPlaying(key)) box.append(div('gn-playbar mono', span('', 'gn-clock')));
        return box;
    }
    const box = div('gn-shot gn-shot-' + (shot.state === 'failed' ? 'fail' : 'wait'),
                    span(shot.state === 'failed' ? (shot.reason || 'no picture') : '…', 'dim'));
    box.style.height = `${Math.round(inner * 9 / 16)}px`;
    return box;
}

/// Play, on the picture. Over the video rather than under it, because the graph
/// is laid out from measured card heights and a control that appeared in the flow
/// would move every node below this one.
function playButton(key) {
    const playing = preview.isPlaying(key);
    return el('button', {
        cls: 'gn-play' + (playing ? ' on' : ''),
        'data-play': key,
        text: playing ? '■' : '▶',
        title: playing ? 'Stop' : 'Play this node from here to the end of the range',
        on: { mousedown: (e) => e.stopPropagation(),
              click: (e) => {
                  e.stopPropagation();
                  const started = playing ? (preview.stopPlay(), true) : preview.startPlay(key);
                  if (hooks.onPlayed) hooks.onPlayed(started);
              } },
    });
}

/// The corner you drag to make a card bigger. The drag writes straight to the
/// element and only commits on release: a redraw per mouse move would re-derive
/// the graph, re-measure every card and lay out the whole screen sixty times a
/// second, and the wires would be the only thing that looked right.
function grip(key, width) {
    if (!key) return null;
    return el('div', { cls: 'gn-grip', 'data-grip': key,
        title: 'Drag to resize — the preview re-renders at the new size',
        on: { mousedown: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (hooks.onResizeStart) hooks.onResizeStart(key, width, e);
        } } });
}
