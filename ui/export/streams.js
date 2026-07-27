// The output's stream list: what will actually be in the file.
//
// The Write stage used to ask for a filename and two flags, which is what a
// render is when a file is a picture and a soundtrack. It is not: a file is a
// list of streams the muxer numbers, and everything this application could not
// say — a second audio track, a language, a forced flag, a fourcc, a font
// travelling beside a subtitle — followed from the list not existing rather
// than from anything harder. So this stage *is* the list, one row per stream,
// and each row is a decision.
//
// **A row reads as a statement, not as a grid of labelled inputs.** "A1 · the
// mix, through aac · English · default" is the sentence a track menu will
// eventually show, and what a person is checking on this stage is whether that
// sentence is the one they meant. What a stream *has* — its metadata, its
// flags, its tag — is a fold, for the same reason the encoder's eighty options
// are a column: everything on the surface at once is nothing on the surface.
//
// Three decisions here are load-bearing rather than incidental:
//
//   - **An attachment is a row and a chapter is not.** An attachment *is* a
//     stream: it has an index, it is what `-attach` produces, and the muxer
//     writes it out of the stream's extradata at header time. A chapter has no
//     index, nothing is mapped to it and it carries no packets — it is a table
//     beside the streams. Drawing them the same way would say they are the
//     same kind of thing, and the first question anybody would then ask ("what
//     is chapter 2's language?") has no answer.
//   - **`settings.audio` and the audio rows are one fact.** Turning sound off
//     on the Encode stage empties the audio rows; adding an audio row here
//     turns it back on. Two switches for one decision is how a render comes
//     out silent while a track list insists it should not have.
//   - **Nothing is written down that libav will answer for.** The dispositions
//     are `av_disposition_to_string` over every bit; the fourccs are what the
//     muxer's own tables confirm for the codec in hand; the codecs are the
//     encoder lists. A stream row cannot offer something the render will then
//     refuse.

import { el, div, span, put, select, row, head, fromTemplate, show } from '../dom.js';
import { basename } from '../format.js';
import { settings, activeVideoCodec, activeAudioCodec } from './state.js';
import { videoEncoders, audioEncoders, muxerInfo, dispositions,
         codecTags } from './capabilities.js';
import { videoOptions, audioOptions } from './options.js';
import { optionColumn } from '../opttable.js';

let host = null;
let hooks = {};

// Which row's detail is open, held by the row's own id rather than by its
// position: removing the row above it would otherwise open a different stream's
// fold, and holding the row object itself would not survive `restore()`.
let openDetail = 0;

let nextId = 100;
const newId = () => ++nextId;

export function initStreams(node, h) {
    host = node;
    hooks = h || {};
}

// ── the model ──────────────────────────────────────────────────────────────

/// The list this application has always written. Not a fallback: it is what
/// nearly every render is, and it arrives without anybody asking.
export function defaultStreams() {
    return [{ id: newId(), kind: 'video', source: 'composite' },
            { id: newId(), kind: 'audio', source: 'mix' }];
}

/// A list read back out of localStorage, made safe to draw.
///
/// A stored blob outlives the shape it was stored in, and a row with no kind —
/// or with a kind this build cannot write — would reach `render.start` and be
/// refused there, on the far side of a form the user cannot see the problem in.
export function normalizeStreams() {
    const list = Array.isArray(settings.streams) ? settings.streams : [];
    const clean = [];
    for (const s of list) {
        if (!s || (s.kind !== 'video' && s.kind !== 'audio' && s.kind !== 'attachment')) continue;
        s.id = newId();
        s.source = s.source || (s.kind === 'video' ? 'composite'
                              : s.kind === 'audio' ? 'mix' : '');
        if (!s.metadata || typeof s.metadata !== 'object') s.metadata = {};
        // A stored chain outlives the shape it was stored in, and a row with no
        // name reaches `render.start` as a bitstream filter called nothing.
        s.bsf = Array.isArray(s.bsf)
            ? s.bsf.filter((b) => b && typeof b.name === 'string')
                   .map((b) => ({ name: b.name, options: Object.assign({}, b.options) }))
            : [];
        clean.push(s);
    }
    settings.streams = clean.length ? clean : defaultStreams();
    syncAudioFlag();
}

export const streamsOf = () => settings.streams;

/// One row's ordinal within its own kind, which is what every stream specifier
/// in ffmpeg counts by: `-metadata:s:a:1` is the second *audio* stream and not
/// the second stream.
export function ordinalOf(list, i) {
    let n = 0;
    for (let k = 0; k < i; k++) if (list[k].kind === list[i].kind) n++;
    return n;
}

const KIND_LETTER = { video: 'V', audio: 'A', attachment: 'T' };

export function labelOf(list, i) {
    return `${KIND_LETTER[list[i].kind] || '?'}${ordinalOf(list, i) + 1}`;
}

/// Which encoder a row comes to. Empty on the row means the Encode stage's,
/// which is a real answer and not an absence — the row draws it, the spec
/// sends it and the command prints it.
export function codecOf(s) {
    if (s.codec) return s.codec;
    return s.kind === 'video' ? activeVideoCodec()
         : s.kind === 'audio' ? activeAudioCodec() : '';
}

export function addStream(kind) {
    const s = { id: newId(), kind, metadata: {} };
    if (kind === 'video') s.source = 'composite';
    if (kind === 'audio') s.source = 'mix';
    if (kind === 'attachment') s.path = '';
    settings.streams.push(s);
    openDetail = s.id;
    syncAudioFlag();
    return s;
}

export function removeStream(id) {
    settings.streams = settings.streams.filter((s) => s.id !== id);
    syncAudioFlag();
}

/// The Encode stage's Include switch, and this list, saying the same thing.
export function setAudioIncluded(on) {
    settings.audio = !!on;
    if (!on) settings.streams = settings.streams.filter((s) => s.kind !== 'audio');
    else if (!settings.streams.some((s) => s.kind === 'audio')) addStream('audio');
}

function syncAudioFlag() {
    settings.audio = settings.streams.some((s) => s.kind === 'audio');
}

// ── what goes to the renderer ──────────────────────────────────────────────

/// The rows as `render.start` wants them, with every default resolved.
///
/// A row that is still being drafted is not sent: an attachment with no file
/// yet would print `-attach` with nothing after it in the command bar and be
/// refused by the renderer, and neither is a useful thing to show somebody who
/// has just pressed "+ Attachment". `warnings()` says so instead, which is
/// where everything that will succeed and be wrong is already said.
export function streamSpecs(over = {}) {
    const out = [];
    for (const s of settings.streams) {
        if (s.kind === 'attachment') {
            if (!s.path) continue;
            out.push({ kind: 'attachment', path: s.path, mimeType: s.mimeType || '' });
            continue;
        }
        if (s.kind === 'audio' && !settings.audio) continue;
        const codec = codecOf(s);
        const meta = Object.assign({}, s.metadata);
        if (s.title) meta.title = s.title;
        out.push({
            kind: s.kind,
            source: s.source || (s.kind === 'video' ? 'composite' : 'mix'),
            codec,
            // The packet chain, in order. An entry with no name is a row
            // somebody has opened and not filled in, and it is dropped for the
            // reason a pathless attachment is: `-bsf:v ,dump_extra` is not a
            // thing, and a render refused over a half-typed row is a refusal
            // about the form rather than about the file.
            bsf: (s.bsf || []).filter((b) => b.name)
                              .map((b) => ({ name: b.name, options: b.options || {} })),
            // The Encode stage's intent, expressed against whatever encoder
            // this row ends up on: a second video stream at x265 gets x265's
            // way of saying the quality that was asked for, not x264's keys.
            options: s.kind === 'video' ? videoOptions(codec, over) : audioOptions(codec),
            metadata: meta,
            language: s.language || '',
            disposition: s.disposition || '',
            tag: s.tag || '',
        });
    }
    return out;
}

// ── drawing ────────────────────────────────────────────────────────────────

export function drawStreams() {
    if (!host) return;
    const list = settings.streams;
    put(host, () => [
        head('What is in the file'),
        div('ex-streams-list', list.map((s, i) => streamRow(list, s, i))),
        div('ex-add', [
            addButton('Video', 'video'),
            addButton('Audio', 'audio'),
            addButton('Attachment', 'attachment'),
        ]),
        head('Chapters'),
        ...chapterRows(),
        head('File metadata'),
        ...pairRows(settings.metadata, 'file', () => hooks.restated()),
    ]);
}

function addButton(label, kind) {
    return el('button', {
        cls: 'tiny', text: `+ ${label}`, 'data-add': kind,
        title: kind === 'attachment'
            ? 'A file that travels inside the output — a font, a cover image'
            : `Another ${kind} stream in the output`,
        on: { click: () => { addStream(kind); hooks.changed(); } },
    });
}

/// One stream, as the sentence it is.
function streamRow(list, s, i) {
    const node = fromTemplate('tpl-stream');
    node.setAttribute('data-stream', String(s.id));
    node.setAttribute('data-kind', s.kind);
    node.querySelector('.ex-stream-n').textContent = labelOf(list, i);

    put(node.querySelector('.ex-stream-says'), () => says(s));

    const tail = node.querySelector('.ex-stream-tail');
    tail.textContent = tailOf(s);

    const more = node.querySelector('[data-f="detail"]');
    const detail = node.querySelector('.ex-stream-detail');
    const opened = openDetail === s.id;
    more.textContent = opened ? '▾' : '▸';
    show(detail, opened);
    more.addEventListener('click', () => {
        openDetail = opened ? 0 : s.id;
        drawStreams();
    });
    if (opened) put(detail, () => detailRows(s, tail));

    node.querySelector('[data-f="drop"]').addEventListener('click', () => {
        removeStream(s.id);
        hooks.changed();
    });
    return node;
}

/// The middle of the sentence: where the stream comes from, and what it goes
/// through. `source` is text rather than a menu because there is one answer
/// per kind today — the composite, or the mix. Stream copy is the second, and
/// this is where `copy:0:1` will become a choice.
function says(s) {
    if (s.kind === 'attachment') {
        const path = el('input', {
            cls: 'wide', 'data-f': 'attach-path', type: 'text', value: s.path || '',
            placeholder: 'a file to carry inside the output',
            on: { change: (e) => { s.path = e.target.value.trim(); hooks.changed(); } },
        });
        return [span('carries', 'dim'), path];
    }

    const list = s.kind === 'video' ? videoEncoders() : audioEncoders();
    const cont = muxerInfo(settings.container) || { videoCodecs: [], audioCodecs: [] };
    const legal = s.kind === 'video' ? cont.videoCodecs : cont.audioCodecs;
    const inherited = s.kind === 'video' ? activeVideoCodec() : activeAudioCodec();

    // "the same as Encode" rather than a blank: a row showing nothing where a
    // codec goes reads as "no codec", and the file will certainly have one.
    const choices = [{ id: '', label: `${inherited || 'container default'}  (from Encode)` }]
        .concat(list.map((e) => ({
            id: e.id,
            label: e.label + (legal.indexOf(e.id) < 0 ? `  (not in ${settings.container})` : ''),
        })));

    return [
        span(s.kind === 'video' ? 'the composite,' : 'the mix,', 'dim'),
        span('through', 'dim'),
        select({ cls: 'ex-stream-codec', 'data-f': 'stream-codec',
                 on: { change: (e) => { s.codec = e.target.value; hooks.changed(); } } },
               choices, s.codec || ''),
    ];
}

/// Everything the row is not spending a control on, as the words a player
/// would use. Rewritten in place when the detail changes, so typing a language
/// does not rebuild the list under the caret.
function tailOf(s) {
    const bits = [];
    if (s.kind === 'attachment') {
        if (s.path) bits.push(basename(s.path));
        if (s.mimeType) bits.push(s.mimeType);
        return bits.join(' · ');
    }
    if (s.language) bits.push(s.language);
    if (s.title) bits.push(`“${s.title}”`);
    for (const d of (s.disposition || '').split(/[+, ]+/).filter(Boolean)) bits.push(d);
    if (s.tag) bits.push(s.tag);
    // The chain, in order and as the command line spells it, because the order
    // is the meaning and a count would hide it.
    const chain = (s.bsf || []).filter((b) => b.name).map((b) => b.name);
    if (chain.length) bits.push(`bsf ${chain.join(',')}`);
    return bits.join(' · ');
}

function detailRows(s, tail) {
    const restate = () => { tail.textContent = tailOf(s); hooks.restated(); };

    if (s.kind === 'attachment') {
        const mime = el('input', {
            cls: 'wide', 'data-f': 'attach-mime', type: 'text', value: s.mimeType || '',
            placeholder: 'guessed from the name',
            on: { change: (e) => { s.mimeType = e.target.value.trim(); restate(); } },
        });
        return [
            row('Mime type', mime),
            div('ex-note dim',
                'An attachment is a stream with no packets in it: the muxer writes the whole ' +
                'file out of the stream at header time, which is what ffmpeg’s -attach does. ' +
                'Matroska holds them; mp4 does not.'),
        ];
    }

    const lang = el('input', {
        cls: 'num', 'data-f': 'stream-lang', type: 'text', value: s.language || '',
        placeholder: 'eng', maxlength: 3,
        on: { change: (e) => { s.language = e.target.value.trim(); restate(); } },
    });
    const title = el('input', {
        cls: 'wide', 'data-f': 'stream-title', type: 'text', value: s.title || '',
        placeholder: 'what a track menu shows',
        on: { change: (e) => { s.title = e.target.value; restate(); } },
    });

    return [
        row('Language', [lang, span('ISO 639-2', 'dim')]),
        row('Name', title),
        row('Flags', dispositionToggles(s, restate)),
        ...tagRow(s, restate),
        head('Metadata'),
        ...pairRows(s.metadata, `s${s.id}`, restate),
        ...bsfRows(s, restate),
    ];
}

// ── the packet chain ───────────────────────────────────────────────────────
//
// A bitstream filter is the one stage of ffmpeg's pipeline that is neither an
// encoder nor a muxer: it works on packets that are already encoded, between
// the two. Which is why it is here and not on the Encode stage, and why it is
// per stream — `-bsf:v` and `-bsf:a` are different chains on different packets.
//
// **It is a list and it is drawn as one.** The order is the whole of the
// meaning: `h264_mp4toannexb,dump_extra` and the same two the other way round
// are different files. So it is a row per filter with the arrows to move one,
// closer to the graph's node list than to the option bags above it — which are
// unordered by nature and drawn as such.
//
// What can go on the list is asked of libavcodec and narrowed to the codec this
// stream is actually encoded with, out of each filter's own `codec_ids`. A
// filter that declares none runs on anything, which is a real answer and not an
// absence, so those are always offered.

function bsfsFor(codec) {
    const all = bro.ffmpeg.bitstreamFilters || [];
    if (!codec) return all;
    // The encoder's name is not the codec's — `libx264` encodes `h264` — and a
    // bsf's list is codec names. Asked of the encoder list rather than by
    // stripping a `lib` prefix, which would be a rule about spellings.
    const enc = (videoEncoders().concat(audioEncoders())).find((e) => e.id === codec);
    const name = (enc && enc.codecName) || codec;
    return all.filter((b) => !b.codecs.length || b.codecs.indexOf(name) >= 0);
}

function bsfRows(s, restate) {
    if (s.kind === 'attachment') return [];
    if (!s.bsf) s.bsf = [];

    const changed = () => { restate(); drawStreams(); };
    const choices = bsfsFor(codecOf(s));

    const rows = [head('Bitstream filters')];
    s.bsf.forEach((b, i) => {
        const pick = select({ cls: 'ex-bsf-name', 'data-f': `bsf-${i}`,
                              on: { change: (e) => { b.name = e.target.value;
                                                     b.options = {}; changed(); } } },
                            [{ id: '', label: 'pick one…' },
                             ...choices.map((c) => ({ id: c.name, label: c.name }))],
                            b.name || '');
        const move = (delta) => el('button', {
            cls: 'tiny', text: delta < 0 ? '↑' : '↓', 'data-bsf-move': `${i}:${delta}`,
            title: 'The order is what runs',
            on: { click: () => {
                const j = i + delta;
                if (j < 0 || j >= s.bsf.length) return;
                const tmp = s.bsf[i]; s.bsf[i] = s.bsf[j]; s.bsf[j] = tmp;
                changed();
            } },
        });
        rows.push(div('ex-bsf-row', [
            span(`${i + 1}`, 'ex-bsf-n dim'), pick, move(-1), move(1),
            el('button', { cls: 'tiny', text: '×', 'data-bsf-drop': String(i),
                           on: { click: () => { s.bsf.splice(i, 1); changed(); } } }),
        ]));
        if (!b.name) return;
        const all = bsfOptionsFor(b.name);
        if (!b.options) b.options = {};
        if (all.length)
            rows.push(...optionColumn({
                name: `bsfopts-${s.id}-${i}`,
                title: `${b.name} options · ${all.length}`,
                options: all,
                bag: b.options,
                hint: 'Anything set here is passed straight to the bitstream filter.',
                onChange: () => restate(),
            }));
    });

    rows.push(div('ex-add', el('button', {
        cls: 'tiny', text: '+ Bitstream filter', 'data-add': 'bsf',
        title: 'Rewrite the packets on the way to the muxer, without re-encoding',
        on: { click: () => { s.bsf.push({ name: '', options: {} }); changed(); } },
    })));
    rows.push(div('ex-note dim',
        `${choices.length} of ${(bro.ffmpeg.bitstreamFilters || []).length} run on ` +
        `${codecOf(s) || 'this stream'} — the rest declare a codec list this stream is ` +
        'not in. They work on packets the encoder has already written, so nothing here ' +
        'costs a re-encode.'));
    return rows;
}

// Cached per filter, exactly as the encoder's and the muxer's tables are: the
// stream list is rebuilt on every keystroke in a language field.
const bsfOptionCache = new Map();

function bsfOptionsFor(name) {
    if (!bsfOptionCache.has(name)) {
        try {
            bsfOptionCache.set(name, bro.ffmpeg.bsfOptions(name) || []);
        } catch (e) {
            bsfOptionCache.set(name, []);
        }
    }
    return bsfOptionCache.get(name);
}

/// One toggle per disposition libavformat knows. Several at once, because a
/// stream can be forced *and* a commentary, and `+forced+comment` is exactly
/// what av_disposition_from_string is handed.
function dispositionToggles(s, restate) {
    const on = new Set((s.disposition || '').split(/[+, ]+/).filter(Boolean));
    const all = dispositions();
    return div('ex-flags', all.map((name) => el('button', {
        cls: 'tiny' + (on.has(name) ? ' on' : ''),
        text: name,
        'data-disp': name,
        on: { click: () => {
            if (on.has(name)) on.delete(name); else on.add(name);
            // Written the way ffmpeg's own `-disposition` argument is, so what
            // is stored is what would be typed.
            s.disposition = on.size ? '+' + Array.from(on).join('+') : '';
            drawStreams();
            restate();
        } },
    })));
}

/// The fourcc, offered as the muxer's own vocabulary rather than as four
/// characters nobody knows to type. hvc1 and hev1 are the same HEVC bitstream
/// and only the first plays on Apple hardware; a container that has nothing to
/// say about this codec shows no control at all rather than an empty menu.
function tagRow(s, restate) {
    if (s.kind !== 'video' && s.kind !== 'audio') return [];
    const tags = codecTags(settings.container, codecOf(s));
    if (!tags.length) return [];
    const choices = [{ id: '', label: `auto (${tags[0]})` }]
        .concat(tags.map((t) => ({ id: t, label: t })));
    return [row('Tag', [
        select({ 'data-f': 'stream-tag',
                 on: { change: (e) => { s.tag = e.target.value; restate(); } } },
               choices, s.tag || ''),
        span(`what ${settings.container} writes as the codec’s fourcc`, 'dim'),
    ])];
}

// ── key/value bags ─────────────────────────────────────────────────────────

/// A metadata dictionary, edited as pairs rather than as a line to be parsed.
///
/// `-metadata key=value` is two strings and a value is free to contain
/// anything, so a single field holding `a=b;c=d` would need an escaping rule
/// that would then be the only place in this application with one.
function pairRows(bag, ns, changed) {
    const out = [];
    for (const k of Object.keys(bag)) out.push(pairRow(bag, ns, k, changed));
    out.push(pairRow(bag, ns, '', changed));
    return out;
}

function pairRow(bag, ns, key, changed) {
    const k = el('input', {
        cls: 'num', 'data-meta-key': `${ns}:${key}`, type: 'text', value: key,
        placeholder: 'key',
        on: { change: (e) => {
            const name = e.target.value.trim();
            const value = bag[key];
            delete bag[key];
            if (name) bag[name] = value === undefined ? '' : value;
            changed();
            drawStreams();
        } },
    });
    const v = el('input', {
        cls: 'wide', 'data-meta-val': `${ns}:${key}`, type: 'text',
        value: key ? String(bag[key]) : '',
        placeholder: key ? '' : 'value',
        on: { change: (e) => {
            const name = k.value.trim();
            if (!name) return;
            bag[name] = e.target.value;
            changed();
            if (!key) drawStreams();
        } },
    });
    return div('ex-pair', [k, v]);
}

// ── chapters ───────────────────────────────────────────────────────────────

/// Beside the streams, drawn as what they are: marks on the output timeline.
///
/// Deliberately not rows in the list above. A chapter has no index, nothing is
/// mapped to it, no player shows it in a track menu, and there is no
/// `-metadata:s:` for one — it is a table in the container. Drawn among the
/// streams it would invite the question "what is chapter 2's language", which
/// has no answer.
function chapterRows() {
    const out = settings.chapters.map((c, i) => {
        const num = (key, cls) => el('input', {
            cls, 'data-ch': `${i}:${key}`, type: 'number', min: 0, step: 0.1,
            value: c[key],
            on: { change: (e) => { c[key] = Math.max(0, Number(e.target.value) || 0);
                                   hooks.restated(); } },
        });
        const title = el('input', {
            cls: 'wide', 'data-ch': `${i}:title`, type: 'text', value: c.title || '',
            placeholder: 'name',
            on: { change: (e) => { c.title = e.target.value; hooks.restated(); } },
        });
        return div('ex-chapter', [
            title, num('start', 'num'), span('→', 'dim'), num('end', 'num'),
            el('button', { cls: 'tiny', text: '×', 'data-ch-drop': String(i),
                           on: { click: () => { settings.chapters.splice(i, 1);
                                                hooks.changed(); } } }),
        ]);
    });
    out.push(div('ex-add', el('button', {
        cls: 'tiny', text: '+ Chapter', 'data-add': 'chapter',
        on: { click: () => {
            const last = settings.chapters[settings.chapters.length - 1];
            const from = last ? last.end : 0;
            settings.chapters.push({ start: from, end: from + 10, title: '' });
            hooks.changed();
        } },
    })));
    return out;
}
