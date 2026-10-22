// Capture stage DOM rendering (device list, graph strip, recording settings,
// recording bar, preview aspect/marquee fitting, and demuxer option column)
// for `ui/capture.js`.

import { div, span, el, put, row, head, setText } from './dom.js';
import { clock, bytes, basename, shellArg } from './format.js';
import { optionColumn } from './opttable.js';
import { qualityRange } from './export/capabilities.js';
import { schemeOf, protocolLinked, newDestination,
         destinationRows } from './export/destination.js';
import { reprobe } from './inputs.js';
import { recordPads } from './graph/record.js';
import { current as overlayState } from './graph/overlay.js';

let ctx = null;
export function bindCaptureDrawContext(c) { ctx = c; }

let nextAlso = 1;

// ── drawing ────────────────────────────────────────────────────────────────

export function drawCapture() {
    const refs = ctx.refs();
    if (!refs.list) return;
    drawDevices();
    ctx.syncCards();
    drawGraph();
    drawSettings();
    drawRecording();
    put(refs.options, () => optionRows());
}

/// The left column: what this machine can capture, and what the focused one of
/// them can see.
///
/// **libav's own human name is the label and the `-f` name is underneath it.**
/// It was the other way round, and a column headed `dshow / gdigrab / lavfi /
/// vfwcap` is a list only somebody who already knows the answer can read. Both
/// strings come out of the registry — `long_name` and `name` — so nothing here
/// is a table of nice names that a different build would fall off the end of.
function drawDevices() {
    const refs = ctx.refs();
    put(refs.list, () => {
        const all = ctx.devices();
        const active = ctx.captureInputs();
        const out = [head('Capture from')];
        if (!all.length) {
            out.push(div('cap-note dim', 'This build registered no capture devices.'));
            return out;
        }
        for (const d of all) {
            const using = active.filter((i) => i.format === d.name).length;
            out.push(el('div', {
                cls: 'cap-device' + (using ? ' on' : ''),
                'data-device': d.name,
                title: `Add ${d.name} input`,
                on: { click: () => ctx.activate(d.name) },
            }, [
                div('cap-device-text', [
                    div('cap-device-name', d.longName || d.name),
                    div('cap-device-what dim mono', `${d.name} · ${d.kinds.join(' · ')}`),
                ]),
                using ? span(`${using}×`, 'cap-device-n') : null,
                span('+', 'cap-device-add'),
            ]));
        }
        const inp = ctx.focused();
        if (inp) {
            const focus = ctx.focus();
            if (active.length > 1)
                out.push(el('div', {
                    cls: 'cap-note dim', text: `Editing [${focus}]`,
                    title: `Editing input [${focus}]`,
                }));
            out.push(...sourceRows(inp));
        }
        return out;
    });
}

export function parseSourcePath(path) {
    let video = '', audio = '';
    if (!path) return { video, audio };
    const vMatch = path.match(/(?:^|:)video=([^:]+)/);
    if (vMatch) video = vMatch[1];
    const aMatch = path.match(/(?:^|:)audio=([^:]+)/);
    if (aMatch) audio = aMatch[1];
    if (!vMatch && !aMatch && path.indexOf('=') < 0) {
        video = path;
    }
    return { video, audio };
}

export function composeSourcePath(video, audio) {
    const parts = [];
    if (video) parts.push(`video=${video}`);
    if (audio) parts.push(`audio=${audio}`);
    return parts.join(':');
}

export function sourceArg(s, audioName) {
    if (typeof s === 'string') {
        return composeSourcePath(s, audioName);
    }
    if (!s) return '';
    if (s.video || s.audio) {
        return composeSourcePath(s.video, s.audio);
    }
    const kinds = s.mediaTypes || [];
    if (kinds.indexOf('video') >= 0) return `video=${s.description || s.name}`;
    if (kinds.indexOf('audio') >= 0) return `audio=${s.description || s.name}`;
    return s.description || s.name;
}

function sourceRows(inp) {
    const list = ctx.sourcesOf(inp.format);
    const HINTS = ctx.hints;
    const out = [head(`What ${inp.format} can see`)];

    if (!list.ok) {
        out.push(el('div', {
            cls: 'cap-note dim',
            text: list.error || `${inp.format} does not list its sources.`,
            title: 'Named directly (no enumeration)',
        }));
        if (HINTS[inp.format])
            out.push(div('btns', [el('button', {
                cls: 'tiny', 'data-f': 'caphint',
                text: `Use “${HINTS[inp.format]}”`,
                title: 'Default hint',
                on: { click: () => setSource(HINTS[inp.format], inp) },
            })]));
        return out;
    }

    const videoSources = list.sources.filter((s) => (s.mediaTypes || []).indexOf('video') >= 0);
    const audioSources = list.sources.filter((s) => (s.mediaTypes || []).indexOf('audio') >= 0);
    const { video: curVideo, audio: curAudio } = parseSourcePath(inp.path);

    if (videoSources.length) {
        const vSelect = el('select', {
            cls: 'wide', 'data-f': 'capvsrc',
            title: 'Select video source',
            on: { change: (e) => {
                const nextPath = composeSourcePath(e.target.value, curAudio);
                ctx.change(inp, { path: nextPath });
            } }
        }, [
            el('option', { value: '', text: 'No video source', selected: !curVideo })
        ].concat(videoSources.map((s) => {
            const name = s.description || s.name;
            return el('option', { value: name, text: name, selected: name === curVideo });
        })));
        out.push(row('Video source', vSelect));
    }

    if (audioSources.length) {
        const aSelect = el('select', {
            cls: 'wide', 'data-f': 'capasrc',
            title: 'Select audio source',
            on: { change: (e) => {
                const nextPath = composeSourcePath(curVideo, e.target.value);
                ctx.change(inp, { path: nextPath });
            } }
        }, [
            el('option', { value: '', text: 'No audio source', selected: !curAudio })
        ].concat(audioSources.map((s) => {
            const name = s.description || s.name;
            return el('option', { value: name, text: name, selected: name === curAudio });
        })));
        out.push(row('Audio source', aSelect));
    }

    for (const s of list.sources) {
        const arg = sourceArg(s);
        const selected = arg === inp.path ||
            ((s.mediaTypes || []).indexOf('video') >= 0 && (s.description || s.name) === curVideo) ||
            ((s.mediaTypes || []).indexOf('audio') >= 0 && (s.description || s.name) === curAudio);

        out.push(el('div', {
            cls: 'cap-device' + (selected ? ' on' : ''),
            'data-source': s.description || s.name,
            title: `Capture from ${s.description || s.name}`,
            on: { click: () => setSource(arg, inp) },
        }, [
            div('cap-device-text', [
                div('cap-device-name', s.description || s.name),
                div('cap-device-what dim mono', (s.mediaTypes || []).join(' · ') || 'unknown'),
            ]),
        ]));
    }
    if (!list.sources.length)
        out.push(div('cap-note dim', 'Nothing plugged in.'));

    if (audioSources.length && inp.path.indexOf('video=') === 0)
        out.push(el('div', {
            cls: 'cap-note dim', text: 'Click a sound source to add a mic.',
            title: 'Add sound source',
        }));

    out.push(div('btns', [el('button', {
        cls: 'tiny', 'data-f': 'caprescan', text: 'Rescan',
        title: 'Rescan devices',
        on: { click: () => { ctx.sourcesOf(inp.format, true); drawCapture(); } },
    })]));
    return out;
}

function setSource(arg, inp) {
    if (!inp) return;
    // A sound source clicked while a camera is chosen joins it rather than
    // replacing it: `video=Cam:audio=Mic` is one input and two streams, which
    // is what dshow means by it.
    const path = (arg.indexOf('audio=') === 0 && inp.path.indexOf('video=') === 0 &&
                  inp.path.indexOf(':audio=') < 0)
        ? `${inp.path}:${arg}`
        : arg;
    ctx.change(inp, { path });
}

// ── the graph ──────────────────────────────────────────────────────────────

/// What the Graph stage says about this recording, in the three states it can
/// be in.
///
/// **Read-only, and that is the change.** There was a textarea here, and three
/// buttons that wrote a chain into it out of the devices' probes. What the
/// buttons did — scale two pictures to one height, stack them, mix whatever
/// sound there is — the Graph stage does with nodes, on a canvas that checks the
/// wiring against libavfilter's own pad lists and can render a preview of any
/// point in it. Keeping the field as well would mean two descriptions of one
/// recording and no rule about which wins.
///
/// The chains are shown rather than hidden because this is where somebody
/// decides whether to press Record, and "what will actually run" is the
/// question they are asking. It is the same text the command bar prints, from
/// the same call.
///
/// **One line, with the door on the end of it.** This was a headed panel and a
/// paragraph, and the paragraph was permanent: "nothing in the graph reads this
/// device" is the ordinary state of a one-device recording, so the commonest
/// screen in the stage carried four lines explaining the case where there is
/// nothing to explain. What a person needs here is the answer — none, this, or
/// this is broken — and a way to go and change it. The argument is in
/// docs/manual/capture.md and in the header above.
export function drawGraph() {
    const refs = ctx.refs();
    const hooks = ctx.hooks();
    const capture = ctx.capture;
    if (!refs.graph) return;
    put(refs.graph, () => {
        if (!capture.inputs.length) return [];
        const g = ctx.graphOf();
        const n = capture.inputs.length;
        const door = (text) => el('button', {
            cls: 'tiny', 'data-f': 'capgraphstage', text,
            title: 'Open Graph stage',
            on: { click: () => { if (hooks.goTo) hooks.goTo('graph'); } },
        });

        const strip = (cls, text, why, label) => div(`cap-strip${cls}`, [
            span('Filters', 'cap-strip-k'),
            el('span', { cls: `cap-strip-v${cls ? ' warn' : ' dim'}`, text, title: why }),
            door(label),
        ]);

        if (!g)
            return n > 1
                ? [strip(' bad', `${n} inputs, nothing joining them`,
                         'Two pictures and nothing saying how they combine is refused ' +
                         'rather than guessed at. Place them on the Graph stage and wire ' +
                         'them to video out.', 'Build')]
                : [strip('', 'none',
                         'Nothing in the graph reads this device, so it is recorded exactly ' +
                         'as it comes. To crop it, or to put a camera in the corner of it, ' +
                         'place it on the Graph stage.', 'Add…')];
        if (!g.ok)
            return [strip(' bad', `will not run — ${g.reason}`,
                          'The Graph stage draws the same problem against the node it is ' +
                          'about.', 'Fix'),
                    ...padRows()];

        const chains = g.filterGraph.split(';');
        return [
            div('cap-strip', [
                span('Filters', 'cap-strip-k'),
                el('span', {
                    cls: 'cap-strip-v',
                    text: `${n} input${n === 1 ? '' : 's'} → ` +
                          [g.video && `[${g.video}]`, g.audio && `[${g.audio}]`]
                              .filter(Boolean).join(' + '),
                    title: 'Mapped streams',
                }),
                door('Edit'),
            ]),
            div('cap-chains', chains.map((chain) => span(chain, 'mono dim cap-chain'))),
            ...padRows(),
        ];
    });
}

function padRows() {
    const capture = ctx.capture;
    const pads = recordPads(overlayState());
    if (pads.v.length < 2 && pads.a.length < 2) return [];
    const pick = (stream) => {
        const list = pads[stream];
        const now = stream === 'v' ? capture.videoPad : capture.audioPad;
        return el('select', {
            cls: 'wide', 'data-f': stream === 'v' ? 'capvpad' : 'capapad',
            title: 'Select graph output pad',
            on: { change: (e) => {
                if (stream === 'v') capture.videoPad = e.target.value;
                else capture.audioPad = e.target.value;
                redraw();
            } },
        }, list.map((p) => el('option', {
            value: p.id, text: p.label, selected: p.id === now,
        })));
    };
    const rows = [];
    if (pads.v.length > 1) rows.push(row('Picture from', pick('v')));
    if (pads.a.length > 1) rows.push(row('Sound from', pick('a')));
    return rows;
}

function drawSettings() {
    const refs = ctx.refs();
    const capture = ctx.capture;
    put(refs.settings, () => {
        const pathField = () => {
            const path = el('input', {
                cls: 'wide', 'data-f': 'cappath', type: 'text', value: capture.path,
                title: 'Output path or URL',
                on: { change: () => { capture.path = path.value.trim(); redraw(); } },
            });
            return path;
        };

        const rows = [head('The recording')];
        if (capture.format === 'tee') {
            rows.push(row('Container', muxerPicker()));
            rows.push(row('', el('span', { cls: 'dim', text:
                'One encode, several muxers. Recording and streaming at once is this: a file ' +
                'and an RTMP URL off one reading of the devices, which is the whole reason ' +
                'tee exists.' })));
            rows.push(...destinationRows({
                list: capture.destinations,
                changed: redraw,
                prefix: 'capdest',
            }));
        } else {
            rows.push(row('Save to', pathField()));
            rows.push(row('Container', muxerPicker()));
            rows.push(...protocolRows());
        }
        rows.push(row('Video', codecPicker(false)));
        rows.push(row('Audio', codecPicker(true)));
        const enc = ctx.effectiveVideo();
        if (enc && enc.crf) rows.push(row('Quality', qualityField(enc)));
        else rows.push(row('Quality', el('span', {
            cls: 'dim', text: enc ? 'fixed' : 'the container decides',
            title: enc
                ? `${enc.label || enc.id} does not support CRF`
                : 'Muxer default encoder',
        })));

        const ends = shortest();
        rows.push(row('Length', el('span', {
            cls: 'dim', text: ends ? clock(ends) : 'until you stop',
            title: ends
                ? `Limited by shortest input (${clock(ends)})`
                : 'No duration limit',
        })));
        rows.push(...alsoRows());
        return rows;
    });
}

function alsoRows() {
    const capture = ctx.capture;
    const pads = recordPads(overlayState());
    const list = capture.also;
    const rows = [head(`${list.length ? '▾' : '▸'} Also write · ${list.length}`, {
        cls: 'section-head ex-toggle', 'data-f': 'capalso',
        on: { click: () => { if (!list.length) addAlso(); } },
    })];

    if (!list.length) {
        rows.push(row('', el('span', { cls: 'dim', text:
            'One encode to several places is the tee muxer, above. This is the other one, ' +
            'and only a recording has it: a second muxer open beside the first, of another ' +
            'end of the same graph. The cameras into one file, a cropped copy into the ' +
            'next — one reading of the devices, because there is no second one to have.' })));
        rows.push(row('', div('btns', [el('button', {
            cls: 'tiny', 'data-f': 'capalso-add', text: '+ File', on: { click: addAlso },
        })])));
        return rows;
    }

    list.forEach((f, i) => {
        const path = el('input', {
            cls: 'wide', 'data-f': `capalso-path-${i}`, type: 'text', value: f.path,
            placeholder: 'where this one goes',
            on: { change: () => { f.path = path.value.trim(); redraw(); } },
        });
        const muxers = (bro.ffmpeg.muxers || []).filter((m) => m.ext && !m.noFile);
        const format = el('select', {
            cls: 'wide', 'data-f': `capalso-format-${i}`,
            on: { change: (e) => { f.format = e.target.value; redraw(); } },
        }, muxers.map((m) => el('option', {
            value: m.name, text: `${m.label || m.name} (.${m.ext})`,
            selected: m.name === f.format,
        })));
        const pick = (stream) => el('select', {
            cls: 'wide', 'data-f': `capalso-${stream}pad-${i}`,
            title: 'Select graph output pad',
            on: { change: (e) => {
                if (stream === 'v') f.videoPad = e.target.value;
                else f.audioPad = e.target.value;
                redraw();
            } },
        }, pads[stream].map((p) => el('option', {
            value: p.id, text: p.label,
            selected: p.id === (stream === 'v' ? f.videoPad : f.audioPad),
        })));

        rows.push(head(`File ${i + 2}`, { cls: 'section-head' }));
        rows.push(row('Picture from', pick('v')));
        rows.push(row('Sound from', pick('a')));
        rows.push(row('Container', format));
        rows.push(row('To', path));
        rows.push(row('', div('btns', [el('button', {
            cls: 'tiny', 'data-f': `capalso-drop-${i}`, text: 'Remove',
            on: { click: () => { capture.also.splice(i, 1); redraw(); } },
        })])));
    });

    rows.push(row('', div('btns', [el('button', {
        cls: 'tiny', 'data-f': 'capalso-add', text: '+ File', on: { click: addAlso },
    })])));
    rows.push(row('', el('span', { cls: 'dim', text:
        'The encoders, the quality and the devices are the recording’s — what a file of ' +
        'its own has is a container, somewhere to go, and which ends of the graph it ' +
        'takes. The size is the pad’s: another size is a scale on the Graph stage with ' +
        'an output to point at.' })));
    return rows;
}

function addAlso() {
    const capture = ctx.capture;
    capture.also.push({ id: nextAlso++, path: '', format: capture.format,
                        videoPad: capture.videoPad, audioPad: capture.audioPad });
    redraw();
}

export function redraw() {
    const hooks = ctx.hooks();
    if (hooks.changed) hooks.changed();
    drawCapture();
    ctx.syncPreviews();
}

function protocolRows() {
    const scheme = schemeOf(ctx.capture.path);
    if (!scheme) return [];
    const linked = protocolLinked(scheme);
    return [row('Protocol', el('span', {
        cls: linked ? 'mono' : 'mono src-missing',
        text: linked ? `${scheme} · linked in` : `${scheme} · not in this build`,
        title: linked ? `${scheme} protocol` : `Protocol ${scheme} not supported`,
    }))];
}

export function regionRows(inp) {
    if (!inp || !ctx.takesRegion(inp.format)) return [];
    const o = inp.options;
    const set = o.video_size || o.offset_x || o.offset_y;
    const reset = el('button', {
        cls: 'tiny', 'data-f': 'capwhole', text: 'Reset',
        title: 'Reset to whole screen',
        on: { click: () => {
            const next = Object.assign({}, inp.options);
            delete next.video_size;
            delete next.offset_x;
            delete next.offset_y;
            ctx.change(inp, { options: next });
        } },
    });
    return [row('Region', el('div', { cls: 'btns' }, [
        el('span', {
            cls: 'mono',
            text: set
                ? `${o.video_size || 'full'} at ${o.offset_x || 0},${o.offset_y || 0}`
                : 'the whole screen',
            title: 'Crop region offset and size',
        }),
        set ? reset : span('· Drag to crop', 'dim'),
    ]))];
}

function muxerPicker() {
    const capture = ctx.capture;
    const all = (bro.ffmpeg.muxers || []).filter((m) => m.ext && !m.noFile);
    const tee = (bro.ffmpeg.muxers || []).find((m) => m.name === 'tee');
    return el('select', {
        cls: 'wide', 'data-f': 'capformat',
        on: { change: (e) => { pickMuxer(e.target.value); } },
    }, all.map((m) => el('option', {
        value: m.name, text: `${m.label || m.name} (.${m.ext})`,
        selected: m.name === capture.format,
    })).concat(tee ? [el('option', {
        value: 'tee', text: 'several destinations (tee)',
        selected: capture.format === 'tee',
    })] : []));
}

function pickMuxer(name) {
    const capture = ctx.capture;
    const was = capture.format;
    capture.format = name;
    if (name === 'tee' && !capture.destinations.length)
        capture.destinations = [
            newDestination({ format: was === 'tee' ? '' : was, path: capture.path }),
            newDestination(),
        ];
    redraw();
}

function codecPicker(audio) {
    const capture = ctx.capture;
    const all = audio ? (bro.ffmpeg.audioEncoders || []) : (bro.ffmpeg.encoders || []);
    const chosen = audio ? capture.audioCodec : capture.videoCodec;
    const m = ctx.codecMuxer();
    const ok = m && m.answersCodecs
        ? all.filter((c) => (audio ? m.audioCodecs : m.videoCodecs).indexOf(c.id) >= 0)
        : all;
    return el('select', {
        cls: 'wide', 'data-f': audio ? 'capacodec' : 'capvcodec',
        on: { change: (e) => {
            if (audio) capture.audioCodec = e.target.value;
            else capture.videoCodec = e.target.value;
            redraw();
        } },
    }, [el('option', { value: '', text: 'the muxer’s default', selected: !chosen })]
        .concat(ok.map((c) => el('option', {
            value: c.id, text: c.label || c.id, selected: c.id === chosen,
        }))));
}

function qualityField(enc) {
    const capture = ctx.capture;
    const hooks = ctx.hooks();
    const q = qualityRange(enc.id);
    const value = span(`crf ${capture.quality}`, 'mono');
    const slider = el('input', {
        'data-f': 'capquality', type: 'range', min: q.min, max: q.max,
        value: String(capture.quality),
        title: `Constant quality (${q.min}=best, ${q.max}=smallest)`,
        on: { input: () => {
            capture.quality = Number(slider.value) || capture.quality;
            value.textContent = `crf ${capture.quality}`;
            if (hooks.changed) hooks.changed();
        }, change: () => redraw() },
    });
    return el('div', { cls: 'btns' }, [slider, value]);
}

export function blockerInfo() {
    const all = ctx.captureInputs();
    if (!all.length) return { text: 'Pick a device', label: 'Pick device', target: 'device' };
    for (let i = 0; i < all.length; i++) {
        const inp = all[i];
        if (!inp.format || !inp.path) return { text: `Input ${i} source is empty`, label: `Go to Input ${i}`, target: 'input', inputIndex: i };
    }
    const opener = ctx.stillOpening();
    if (opener) {
        const idx = all.findIndex(i => i.id === opener.id);
        const inputIdx = idx >= 0 ? idx : 0;
        return { text: `Input ${inputIdx} is still opening`, label: `Go to Input ${inputIdx}`, target: 'input', inputIndex: inputIdx };
    }
    const g = ctx.graphOf();
    if (g && !g.ok) return { text: 'Graph won’t run', label: 'Fix on Graph', target: 'graph' };
    if (all.length > 1 && !g) return { text: 'Needs a graph', label: 'Open Graph', target: 'graph' };
    if (ctx.clashingPath()) return { text: 'Two files, one path', label: 'Fix path', target: 'settings' };
    if (!ctx.recordTarget()) return { text: 'Nowhere to write', label: 'Set path', target: 'settings' };
    return null;
}

export function jumpToBlocker(b) {
    if (!b) return;
    const refs = ctx.refs();
    const hooks = ctx.hooks();
    const cards = ctx.cards();
    if (b.target === 'device') {
        if (refs.list) refs.list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (b.target === 'input') {
        if (b.inputIndex !== undefined && b.inputIndex >= 0) {
            ctx.setFocus(b.inputIndex);
            drawCapture();
            if (cards[b.inputIndex] && cards[b.inputIndex].root) {
                cards[b.inputIndex].root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    } else if (b.target === 'graph') {
        if (hooks.goTo) hooks.goTo('graph');
    } else if (b.target === 'settings') {
        if (refs.settings) refs.settings.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const pathEl = document.querySelector('[data-f="cappath"]');
        if (pathEl) pathEl.focus();
    }
}

function destinationWhat() {
    const capture = ctx.capture;
    const m = (bro.ffmpeg.muxers || []).find((x) => x.name === capture.format);
    const enc = ctx.effectiveVideo();
    return [m ? (m.label || m.name) : capture.format, enc && (enc.label || enc.id)]
        .filter(Boolean).join(' · ');
}

function destinationName() {
    const capture = ctx.capture;
    if (capture.format !== 'tee')
        return { text: basename(capture.path) || 'unnamed', title: capture.path };
    const n = (capture.destinations || []).filter((d) => d.path).length;
    return { text: `${n} destination${n === 1 ? '' : 's'}`, title: ctx.recordTarget() };
}

/// The bar's readouts while a recording runs, written into place once a frame.
///
/// **The Stop button is built once and the numbers are written into it**, and
/// this used to be the other way round: `drawRecording()` ran on every frame of
/// a recording and `put()` emptied the bar and built a fresh Stop button each
/// time. A hand holds a button for a frame or more, so by the release the node
/// that was pressed was gone and a stranger stood in its place — and a press
/// and a release on two different elements is a click on the nearest element
/// containing both, which for a node that has left the tree is nothing. So
/// Stop could not be pressed, ever, and the suite never saw it because it
/// stopped recordings with a synthesised `.click()`, which asks nobody where
/// the press landed. `tests/ui_capture.js` now presses it through the engine.
/// `ui/dom.js`'s `setText` says the rest: a readout rewritten to say the same
/// thing is a layout for nothing.
let barMode = '';
let readouts = null;

export function tickRecording() {
    if (barMode !== 'recording' || !readouts) { drawRecording(); return; }
    const st = ctx.recordingStatus() || {};
    setText(readouts.elapsed, clock(st.elapsed || 0));
    setText(readouts.frames, `${st.frames || 0} frames`);
    setText(readouts.bytes, bytes(st.bytes || 0));
    setText(readouts.until, st.openEnded
        ? 'runs until you stop it'
        : `${Math.round((st.progress || 0) * 100)}% of ${clock(shortest())}`);
}

export function drawRecording() {
    const refs = ctx.refs();
    const hooks = ctx.hooks();
    const recording = ctx.isRecording();
    if (!refs.bar) return;
    barMode = recording ? 'recording' : 'idle';
    readouts = null;
    put(refs.bar, () => {
        const out = [];
        if (recording) {
            const st = ctx.recordingStatus() || {};
            readouts = {
                elapsed: span(clock(st.elapsed || 0), 'cap-elapsed mono'),
                frames: span(`${st.frames || 0} frames`, 'dim mono'),
                bytes: span(bytes(st.bytes || 0), 'dim mono'),
                until: el('span', {
                    cls: 'dim',
                    text: st.openEnded
                        ? 'runs until you stop it'
                        : `${Math.round((st.progress || 0) * 100)}% of ${clock(shortest())}`,
                    title: st.openEnded ? 'No duration limit set' : undefined,
                }),
            };
            out.push(el('button', {
                cls: 'cap-go', 'data-f': 'capstop',
                title: 'Stop recording',
                on: { click: ctx.stopRecording },
            }, [div('cap-go-dot stop'), span('Stop')]));
            out.push(readouts.elapsed, readouts.frames, readouts.bytes);
            out.push(div('spacer'));
            out.push(readouts.until);
        } else {
            const b = blockerInfo();
            const why = b ? b.text : '';
            const dest = destinationName();
            out.push(el('button', {
                cls: 'cap-go', 'data-f': 'caprecord', disabled: !!why,
                title: why || `Record to ${dest.title}`,
                on: { click: ctx.startRecording },
            }, [div('cap-go-dot'), span('Record')]));
            if (b) {
                out.push(el('div', { cls: 'cap-blocker-row' }, [
                    span(b.text, 'cap-why'),
                    el('button', {
                        cls: 'tiny cap-jump-btn',
                        'data-f': 'capjumpblocker',
                        text: b.label,
                        title: `Jump to ${b.label}`,
                        on: { click: () => jumpToBlocker(b) },
                    }),
                ]));
            } else out.push(div('cap-dest', [
                el('div', {
                    cls: 'cap-dest-name mono', text: dest.text, title: dest.title,
                }),
                div('cap-dest-what dim', destinationWhat()),
            ]));
            out.push(div('spacer'));
            const last = ctx.lastRecorded();
            if (last.file) {
                out.push(el('span', {
                    cls: 'mono', text: basename(last.file),
                    title: `Just recorded: ${last.file}`,
                }));
                out.push(span(bytes(last.bytes), 'dim mono'));
                out.push(el('button', {
                    cls: 'tiny', 'data-f': 'capuse', text: 'Add to timeline',
                    title: 'Add recorded file to timeline',
                    on: { click: () => { if (hooks.open) hooks.open(last.file); } },
                }));
            }
        }
        return out;
    });

    if (refs.note) {
        put(refs.note, () => {
            if (recording)
                return [el('div', {
                    cls: 'cap-note dim', text: 'Previews are dark while recording (hardware devices in exclusive use).',
                    title: 'Hardware capture devices are opened exclusively by the recording encoder.',
                })];
            return [];
        });
    }
}

/// The `-t` that ends the session: the shortest of the inputs', or zero when
/// any of them runs until stopped. The engine's rule, said the same way here —
/// see `limitOf` in ffmpeg_capture.cpp.
function shortest() {
    let best = 0;
    for (const i of ctx.captureInputs()) {
        if (!i.to) continue;
        if (!best || i.to < best) best = i.to;
    }
    return best;
}

// ── the pictures, fitted ───────────────────────────────────────────────────

/// Place each preview inside its card at its own aspect.
///
/// Not `object-fit`, and not left to stretch. Stretching matters here more than
/// it does anywhere else in this application: a region is dragged on this
/// picture, so a picture that is not the shape of the screen is a rectangle
/// that is not the shape of the one you drew. Fitted, the drag is one ratio in
/// both axes and the box on screen is the box that gets captured.
export function fitPreviews() {
    for (const c of ctx.cards()) fitOne(c);
}

export function syncMarquee(c, input) {
    if (!c || !c.video || !c.marquee || !input) return;
    const o = input.options || {};
    if (!ctx.takesRegion(input.format) || !o.video_size) {
        if (!c.dragging) c.marquee.classList.add('hidden');
        return;
    }
    const parts = String(o.video_size).split('x');
    const rw = Number(parts[0]) || 0;
    const rh = Number(parts[1]) || 0;
    const rx = Number(o.offset_x) || 0;
    const ry = Number(o.offset_y) || 0;
    if (!rw || !rh) {
        if (!c.dragging) c.marquee.classList.add('hidden');
        return;
    }

    const shownW = c.video.clientWidth || 1;
    const shownH = c.video.clientHeight || 1;
    const realW = c.video.videoWidth || shownW;
    const realH = c.video.videoHeight || shownH;

    const leftInVid = (rx * shownW) / realW;
    const topInVid = (ry * shownH) / realH;
    const wInVid = (rw * shownW) / realW;
    const hInVid = (rh * shownH) / realH;

    const picBox = c.pic.getBoundingClientRect();
    const vidBox = c.video.getBoundingClientRect();
    const offsetX = vidBox.left - picBox.left;
    const offsetY = vidBox.top - picBox.top;

    c.marquee.style.left = `${Math.round(offsetX + leftInVid)}px`;
    c.marquee.style.top = `${Math.round(offsetY + topInVid)}px`;
    c.marquee.style.width = `${Math.round(wInVid)}px`;
    c.marquee.style.height = `${Math.round(hInVid)}px`;
    c.marquee.classList.remove('hidden');
}

function fitOne(c) {
    if (!c.video) return;
    const vw = c.video.videoWidth, vh = c.video.videoHeight;
    const cw = c.pic.clientWidth, ch = c.pic.clientHeight;
    if (!vw || !vh || !cw || !ch) return;
    const scale = Math.min(cw / vw, ch / vh);
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (c.video.clientWidth !== w || c.video.clientHeight !== h) {
        c.video.style.width = `${w}px`;
        c.video.style.height = `${h}px`;
        c.video.style.left = `${Math.round((cw - w) / 2)}px`;
        c.video.style.top = `${Math.round((ch - h) / 2)}px`;
    }
    const idx = ctx.cards().indexOf(c);
    if (idx >= 0) syncMarquee(c, ctx.captureInputs()[idx]);
}

// ── the option column ──────────────────────────────────────────────────────

function optionRows() {
    const inp = ctx.focused();
    if (!inp) return [];
    let all = [];
    try { all = bro.ffmpeg.demuxerOptions(inp.format) || []; } catch (e) { all = []; }
    const focus = ctx.focus();
    const capture = ctx.capture;
    return optionColumn({
        name: 'capoptsearch',
        title: capture.inputs.length > 1
            ? `[${focus}] ${inp.format} options · ${all.length}`
            : `${inp.format} options · ${all.length}`,
        // No note. The column used to open with three sentences about where the
        // table comes from and what an unknown key does — permanently on
        // screen, above a search box, for a table most recordings never touch.
        // The one consequence worth knowing rides on the hint line, which is
        // only drawn while the list is empty anyway.
        note: '',
        options: all,
        bag: inp.options,
        hint: 'An unknown key stops the open.',
        // The bag is edited in place, so the input has to be told to open
        // again with it — the same call the Sources stage makes after editing
        // a file's demuxer options, and for the same reason.
        onChange: () => ctx.withDevicesFree(() => reprobe(inp)),
    });
}

// ── the command ────────────────────────────────────────────────────────────

/// The capture as the command it is, or null when this stage is not the one
/// being described.
///
/// Read by ui/command.js, which prefers it to the render's while the Capture
/// stage is up. The shape is the same `{ pre, inputs, out }` the render's is,
/// so the bar draws one the way it draws the other.
///
/// **Every `-i` here is exact and the `-filter_complex` is exact too**, which
/// is the difference between this bar and the render's: a render's composition
/// is *equivalent* because the compositor stacks RGBA rather than building a
/// graph, and a recording has no compositor — the string in the field is handed
/// to `avfilter_graph_parse2` and nothing rewrites it on the way.
export function commandParts() {
    const capture = ctx.capture;
    const all = ctx.captureInputs().filter((i) => i.format && i.path);
    if (!all.length) return null;

    const inputs = [];
    for (const input of all) {
        inputs.push('-f', shellArg(input.format));
        // Everything the input carries that goes in front of the `-i`, and not
        // only the demuxer bag: a `-hwaccel` or a `-probesize` set on the
        // Sources stage is part of this `-i` now, and a bar that printed the
        // device without them would be printing a different open from the one
        // the recording performs.
        for (const bag of [input.options, input.decoderOptions || {}])
            for (const k of Object.keys(bag))
                if (bag[k] !== '' && bag[k] !== undefined)
                    inputs.push(`-${k}`, shellArg(bag[k]));
        if (input.hwaccel) inputs.push('-hwaccel', shellArg(input.hwaccel));
        if (input.hwaccelDevice) inputs.push('-hwaccel_device', shellArg(input.hwaccelDevice));
        if (input.hwaccelOutputFormat)
            inputs.push('-hwaccel_output_format', shellArg(input.hwaccelOutputFormat));
        // `-t` in front of the `-i`, where it belongs: after it, it would limit
        // the *output* — nearly the same file and a different instruction,
        // which is exactly the kind of thing this bar exists to stop somebody
        // guessing at.
        if (input.to) inputs.push('-t', String(input.to));
        inputs.push('-i', shellArg(input.path));
    }

    const enc = ctx.effectiveVideo();
    const out = [];
    // The same call `startRecording` makes, so the bar cannot print a graph the
    // recording would not run. A refusal prints nothing rather than a chain
    // that does not parse: the Record button is disabled and the reason is on
    // the stage, and a command bar repeating it in ffmpeg's vocabulary would be
    // offering a line to copy that fails the same way.
    const graph = ctx.graphOf();
    if (graph && graph.ok) {
        out.push('-filter_complex', shellArg(graph.filterGraph));
        // What the writer maps. A pad labelled `[vout]`/`[aout]` is the one the
        // muxer takes, which is `resolvePads`' rule stated in the vocabulary of
        // the command line — and a graph that labels neither leaves its single
        // pad as the composite, which `-map` does not need to say.
        for (const label of [graph.video, graph.audio])
            if (label) out.push('-map', `[${label}]`);
    }
    // Everything a file is encoded with, which is the same for all of them: a
    // second file is another muxer and another set of pads, not another set of
    // encode settings — see `capture.also`.
    const encoded = () => {
        const bits = [];
        const codecs = ctx.effectiveCodecs();
        if (codecs.video) bits.push('-c:v', codecs.video);
        if (codecs.audio) bits.push('-c:a', codecs.audio);
        if (enc && enc.crf && capture.quality) bits.push('-crf', String(capture.quality));
        if (enc && enc.preset) bits.push('-preset', 'veryfast');
        return bits;
    };
    out.push(...encoded());
    if (capture.format) out.push('-f', capture.format);
    out.push(shellArg(ctx.recordTarget() || 'capture.mkv'));

    // **Several files is several outputs on one command line**, which is what
    // ffmpeg has always been able to do and this application could not say
    // until now. Each carries its own `-map` because the first output's is the
    // graph's default and the rest have to name the pad they are of — which is
    // exactly what the spec sends, so the bar and the recording cannot
    // disagree about which end goes where.
    const files = graph && graph.ok && graph.files ? graph.files : [];
    ctx.alsoFiles().forEach((f, i) => {
        const pads = files[i + 1];
        if (pads) for (const label of [pads.video, pads.audio])
            if (label) out.push('-map', `[${label}]`);
        out.push(...encoded());
        if (f.format) out.push('-f', f.format);
        out.push(shellArg(f.path));
    });

    return { pre: ['ffmpeg'], inputs, out };
}
