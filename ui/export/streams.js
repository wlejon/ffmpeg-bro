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
//     out silent while a track list insists it should not have. What the switch
//     is about is *the mix*, so a row whose sound comes from somewhere else —
//     a copied track, a pad of the graph — is outside it in both directions.
//   - **Nothing is written down that libav will answer for.** The dispositions
//     are `av_disposition_to_string` over every bit; the fourccs are what the
//     muxer's own tables confirm for the codec in hand; the codecs are the
//     encoder lists. A stream row cannot offer something the render will then
//     refuse.

import { el, div, span, put, select, row, head, fromTemplate, show } from '../dom.js';
import { basename } from '../format.js';
import { project, hasPicture } from '../project.js';
import { inputs, hasSound, lengthOf as inputLength } from '../inputs.js';
import { settings, activeVideoCodec, activeAudioCodec } from './state.js';
import { videoEncoders, audioEncoders, muxerInfo, dispositions,
         codecTags } from './capabilities.js';
import { videoOptions, audioOptions } from './options.js';
import { optionColumn } from '../opttable.js';
import { parseCopy, isCopy, copyChoices, copiedStream, copiedInput,
         keyframesFor, keyframeAtOrBefore, inPointNote, rewrapRows } from './copy.js';
import { subtitleChoices, subtitleEncoders, subtitleCodecsOf, defaultSubtitleCodec,
         holdsSubtitles, isDecode, readsInput, readStream, readInput,
         defaultSubtitleSource } from './subtitles.js';
import { isPad, padChoices } from './pads.js';
import { wires as overlayWires } from '../graph/overlay.js';

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
        if (!s || (s.kind !== 'video' && s.kind !== 'audio' && s.kind !== 'attachment' &&
                   s.kind !== 'subtitle')) continue;
        s.id = newId();
        s.source = s.source || (s.kind === 'video' ? 'composite'
                              : s.kind === 'audio' ? 'mix' : '');
        // A subtitle row reads an input and there is no composed source to fall
        // back to, so a row whose input has gone takes the first subtitle
        // stream that is still there — and is dropped when there is none. It
        // cannot become "the mix" the way a stale copy of a soundtrack can.
        if (s.kind === 'subtitle') {
            const at = readsInput(s);
            const gone = !at || !inputs[at.input] || !(inputs[at.input].probe || {}).streams;
            if (gone) {
                // Not called `put`: that is `dom.js`'s, imported at the top of
                // this file, and shadowing it here made one of the two names in
                // this module mean something else for eight lines.
                const fallback = defaultSubtitleSource(settings.container);
                if (!fallback) continue;
                s.source = fallback;
            }
        }
        // A copy names an input by index, and the index is the document's `-i`
        // numbering — which the document this list was stored under no longer
        // is. A row pointing past the end of the input list would reach
        // `render.start` and be refused there, on the far side of a form where
        // nothing looks wrong, so it comes back as the composed source it would
        // have been.
        const at = parseCopy(s.source);
        if (s.kind !== 'subtitle' && at &&
            (!inputs[at.input] || !(inputs[at.input].probe || {}).streams))
            s.source = s.kind === 'video' ? 'composite' : 'mix';
        s.copyFrom = Number(s.copyFrom) || 0;
        s.copyTo = Number(s.copyTo) || 0;
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

const KIND_LETTER = { video: 'V', audio: 'A', subtitle: 'S', attachment: 'T' };

export function labelOf(list, i) {
    return `${KIND_LETTER[list[i].kind] || '?'}${ordinalOf(list, i) + 1}`;
}

/// Which encoder a row comes to. Empty on the row means the Encode stage's,
/// which is a real answer and not an absence — the row draws it, the spec
/// sends it and the command prints it.
export function codecOf(s) {
    // A copied stream has no encoder at all: what is in the file is what was in
    // the input, and the codec is a fact rather than a choice. Reported as that
    // fact so the bitstream-filter list, the tag vocabulary and the container
    // checks all narrow to the codec the file will actually carry.
    const copied = copiedStream(s);
    if (copied) return copied.codec;
    if (s.codec) return s.codec;
    return s.kind === 'video' ? activeVideoCodec()
         : s.kind === 'audio' ? activeAudioCodec()
         : s.kind === 'subtitle' ? defaultSubtitleCodec(settings.container) : '';
}

export function addStream(kind) {
    const s = { id: newId(), kind, metadata: {} };
    if (kind === 'video') s.source = 'composite';
    if (kind === 'audio') s.source = 'mix';
    if (kind === 'attachment') s.path = '';
    // A subtitle row has nothing composed to point at, so it arrives pointing
    // at the first subtitle stream there is. Added at all only where there is
    // one — see `addButton`, which says so rather than offering a row that
    // cannot be filled in.
    if (kind === 'subtitle') s.source = defaultSubtitleSource(settings.container);
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
///
/// **A copied soundtrack is outside this.** The switch is about the mix — the
/// thing the encoder is fed — and a stream whose packets come out of a demuxer
/// is not made of it. Turning sound off with a copied audio row on the list
/// leaves that row alone, because taking it away would be turning off something
/// the switch does not control.
///
/// **And so is one fed from a graph pad**, for the same reason spelt one stage
/// over: its samples are made inside libavfilter, out of whatever that chain
/// reads — a `sine`, a second file, an `amix` this render is not the mix of.
/// Native draws the identical line in `outputStreams()`, and this is a
/// *correctness* claim rather than thrift: emptied by the switch, a graph that
/// produces a soundtrack and maps it to a stream of its own would come out
/// silent and say nothing.
const madeOfTheMix = (s) => s.kind === 'audio' && !isCopy(s) && !isPad(s);

/// The same distinction one stream kind over: a picture this render *composes*,
/// as against one it copies or takes off a named pad of the graph.
const madeOfTheComposite = (s) => s.kind === 'video' && !isCopy(s) && !isPad(s);

export function setAudioIncluded(on) {
    settings.audio = !!on;
    if (!on)
        settings.streams = settings.streams.filter((s) => !madeOfTheMix(s));
    else if (!settings.streams.some(madeOfTheMix))
        addStream('audio');
}

function syncAudioFlag() {
    settings.audio = settings.streams.some(madeOfTheMix);
}

/// Is there anything on this timeline for the mix to be made of?
///
/// **The term the JS side did not have.** Native decides by opening: `wantAudio`
/// in `export_timeline.cpp` is set only when a clip's `SourceAudio::open`
/// succeeds, and `outputStreams()` then drops every non-copied audio stream. So
/// a video-only timeline has always produced a file with no soundtrack in it,
/// correctly — while this stage drew "A1 · the mix, through aac" for that stream
/// and the command bar printed `-map [a0]` against an `-i` with no `[0:a]` in
/// it. Pasted into a real ffmpeg that fails with *Stream specifier ':a' matches
/// no streams*, which is the printed-command claim breaking.
///
/// It is derived here rather than found out by opening because the UI cannot
/// open anything: what it has is `streamKinds()`, the probe's own answer, and
/// native stays authoritative for the render itself.
///
/// **A copied soundtrack is outside this**, as it is outside `settings.audio`:
/// its packets come out of a demuxer whether or not this edit has any sound.
///
/// The graph is the other half of it. A `sine` or an `anullsrc` wired to
/// `audio out` is a render with a soundtrack and no clip anywhere near it —
/// `derive()` grows the `out:a` sink for exactly that — so the mix is fed by
/// an audible clip *or* by a wire somebody drew.
export function hasAudibleSound() {
    if (project.clips.some((c) => !c.muted && c.volume > 0 && hasSound(c.input))) return true;
    return overlayWires().some((w) => w.to === 'out:a');
}

/// Is there anything on this timeline for the composite to be made of?
///
/// The mirror of the term above, and it arrived with audio-only inputs for the
/// same reason that one arrived with the silent fixture: `settings.streams`
/// carries a video row whatever the timeline turns out to hold, so a timeline of
/// nothing but sound drew "V1 · the composite, through libx264" and rendered a
/// black rectangle at the canvas size. That is not a failed render — it is a
/// file twice the size it should be with a picture in it nobody asked for, which
/// is the failure this list exists to catch.
///
/// **Only a timeline that has clips and no pictures among them answers no.** An
/// empty timeline is the generator case — `ffmpeg -f lavfi -i testsrc` — where
/// the picture comes from the graph and the composite is exactly what should be
/// written; so is a wire drawn to `video out`. Both are the same two exemptions
/// `hasAudibleSound` makes and for the same reason.
export function hasVisiblePicture() {
    if (!project.clips.length) return true;
    if (project.clips.some(hasPicture)) return true;
    return overlayWires().some((w) => w.to === 'out:v');
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
        // A copied soundtrack is not the mix, so the Encode stage's Include
        // switch has nothing to say about it: its packets come out of a
        // demuxer whether or not this edit has any sound in it.
        //
        // Nor is a mix that nothing feeds. Native drops it either way — it
        // finds out by opening — so this is the same file with or without the
        // term; what changes is that the command bar stops printing `-map
        // [a0]` for a pad no `-i` produces, which is a command that fails.
        //
        // Nor is one fed from a graph pad, and that exemption is the same kind
        // of claim as the copy's — correctness, not thrift. Its samples are
        // libavfilter's, so the timeline having nothing audible on it says
        // nothing about whether the stream has anything to write.
        if (madeOfTheMix(s) && (!settings.audio || !hasAudibleSound())) continue;
        // And a composite nothing feeds, which is the same claim about the
        // other half of the file: a timeline of nothing but sound has no
        // picture to write, and a black rectangle at the canvas size is not
        // what "render this" meant. Unlike the mix, native cannot decide it by
        // opening — a graph with a generator in it composes a picture out of
        // nothing at all — so this side is the only one that can say so.
        if (madeOfTheComposite(s) && !hasVisiblePicture()) continue;
        // A subtitle row with nowhere to read from is a row somebody added
        // before adding the file. Dropped rather than sent, exactly as a
        // pathless attachment is: `warnings()` says so where a refusal from
        // the renderer would only say it about a form nobody can see.
        if (s.kind === 'subtitle' && !readsInput(s)) continue;
        const copying = isCopy(s);
        const codec = copying ? '' : codecOf(s);
        const meta = Object.assign({}, s.metadata);
        if (s.title) meta.title = s.title;
        out.push({
            kind: s.kind,
            source: s.source || (s.kind === 'video' ? 'composite' : 'mix'),
            // Empty on a copy, and refused by the renderer if it is not: there
            // is no encoder to name, and a codec that reached one would be a
            // setting that silently did nothing.
            codec,
            // The span read out of the input, on the input's own clock. It
            // means the same thing for a converted subtitle track as for a
            // copy — where the reading starts and where the output's zero is
            // — which is why there is one pair of fields rather than two.
            copyFrom: copying || isDecode(s) ? (Number(s.copyFrom) || 0) : 0,
            copyTo: copying || isDecode(s) ? (Number(s.copyTo) || 0) : 0,
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
            // A copied stream has no encoder for any of it to reach.
            options: copying || s.kind === 'subtitle' ? {}
                   : s.kind === 'video' ? videoOptions(codec, over) : audioOptions(codec),
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
            ...subtitleAdd(),
            addButton('Attachment', 'attachment'),
        ]),
        ...rewrapRow(),
        head('Chapters'),
        ...chapterRows(),
        head('File metadata'),
        ...pairRows(settings.metadata, 'file', () => hooks.restated()),
    ]);
}

/// "Just rewrap this" and "cut this without re-encoding", which is what most
/// people arrive wanting and which building a stream list by hand is a long way
/// round to.
///
/// **It is a shortcut and not a mode.** What it does is write ordinary rows with
/// ordinary `copy:` sources into the list above, so the whole of what it decided
/// is visible, editable and undoable the moment it has run — the same rule the
/// Report drawer's measurement shortcuts follow, where what you get is an
/// ordinary node on the graph. There is no hidden flag anywhere and nothing on
/// this stage behaves differently afterwards.
function rewrapRow() {
    const usable = inputs.filter((i) => i.probe &&
                                        i.probe.streams.some((s) => s.kind === 'video' ||
                                                                    s.kind === 'audio'));
    if (!usable.length) return [];
    return [
        head('Copy it instead'),
        div('ex-add', usable.map((input) => el('button', {
            cls: 'tiny', text: `Rewrap ${input.name}`,
            'data-rewrap': input.id,
            title: 'Every stream of this input, copied — no decode, no encode, ' +
                   'the same bytes in a different container',
            on: { click: () => rewrap(inputs.indexOf(input)) },
        }))),
        div('ex-note dim',
            'A copied stream is the packets that are already in the file: instant, ' +
            'lossless, and untouched by anything on the Compose or Graph stages. ' +
            'A cut can only start at a keyframe — open a row to see where they are.'),
    ];
}

function rewrap(index) {
    const rows = rewrapRows(index, newId, null);
    if (!rows.length) return;
    settings.streams = rows;
    // **The container is deliberately left alone.** Which muxer to write is the
    // whole of the remaining decision and it is taken on its own control a foot
    // away; changing it here would be this shortcut making the choice somebody
    // came to this stage to make. A container that will not hold what is being
    // copied is refused by `warnings()` with both named.
    openDetail = rows[0].id;
    syncAudioFlag();
    hooks.changed();
}

/// `+ Subtitle`, and the two reasons it might not be offered.
///
/// **Both are worth saying rather than hiding.** A stage with no subtitle
/// button on it reads as an application that cannot write subtitles, which is
/// the wrong conclusion from either "you have not added the file yet" or "this
/// container holds none". So the button is there when a subtitle track can
/// actually be made and the reason is there when it cannot.
function subtitleAdd() {
    const holds = holdsSubtitles(settings.container);
    const sources = subtitleChoices().length > 0;
    if (holds && sources) return [addButton('Subtitle', 'subtitle')];
    return [div('ex-note dim',
                !holds
                    ? `The ${settings.container} muxer holds no subtitle codec this build ` +
                      'can write, so there is no subtitle stream to add. Matroska holds ass, ' +
                      'subrip and webvtt; mp4 holds mov_text. Burning them into the picture ' +
                      'is a subtitles filter on the Graph stage and works in any container.'
                    : 'A subtitle stream is read out of a file — an .srt, a .vtt, an .ass, or ' +
                      'a track already inside a video. Add one on the Sources stage and it ' +
                      'can be carried through or converted here.')];
}

function addButton(label, kind) {
    return el('button', {
        cls: 'tiny', text: `+ ${label}`, 'data-add': kind,
        title: kind === 'attachment'
            ? 'A file that travels inside the output — a font, a cover image'
            : kind === 'subtitle'
                ? 'A subtitle track in the output, carried through or converted'
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
/// through.
///
/// **Two decisions, and the first one changes what the second can be.** A
/// stream is either made — the composite, the mix — or copied, and a copied one
/// has no encoder to pick: the codec in the file is the codec that was in the
/// input, so it is stated rather than offered. Drawing the encoder menu anyway,
/// disabled, would say there was a choice being withheld; there is no choice.
function says(s) {
    if (s.kind === 'attachment') {
        const path = el('input', {
            cls: 'wide', 'data-f': 'attach-path', type: 'text', value: s.path || '',
            placeholder: 'a file to carry inside the output',
            on: { change: (e) => { s.path = e.target.value.trim(); hooks.changed(); } },
        });
        return [span('carries', 'dim'), path];
    }

    // **A subtitle row has no composed source**, so its sentence is a different
    // sentence: not "made or copied" but "which track, carried or converted".
    // Drawing it with the other two would put "the composite" in a menu where
    // it means nothing.
    if (s.kind === 'subtitle') return saysSubtitle(s);

    // Three answers, not two: made from the edit, made by the graph and taken
    // off a pad somebody named, or copied straight out of an input. The middle
    // one is what makes a second picture out of one render — two crops of a
    // wide screen grab, a proxy beside a master — and it is offered only where
    // an output has been placed, because a menu entry for a graph nobody has
    // touched would be a choice that cannot be made.
    const made = s.kind === 'video' ? 'the composite' : 'the mix';
    const sources = [{ id: s.kind === 'video' ? 'composite' : 'mix', label: made }]
        .concat(padChoices(s.kind).map((c) => ({ id: c.id, label: c.label })))
        .concat(copyChoices(s.kind).map((c) => ({ id: c.id, label: `copy — ${c.label}` })));
    const picker = select({ cls: 'ex-stream-src', 'data-f': 'stream-source',
                            title: 'Made from the edit, taken off a pad of the graph, ' +
                                   'or copied straight out of an input',
                            on: { change: (e) => { setSource(s, e.target.value); } } },
                          sources, s.source || (s.kind === 'video' ? 'composite' : 'mix'));

    const copied = copiedStream(s);
    if (copied) {
        const input = copiedInput(s);
        return [
            picker,
            span('·', 'dim'),
            span(`${copied.codec}, as it is`, 'ex-stream-copied'),
            span(input ? `out of ${input.name}` : '', 'dim'),
        ];
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

    const out = [
        picker,
        span('through', 'dim'),
        select({ cls: 'ex-stream-codec', 'data-f': 'stream-codec',
                 on: { change: (e) => { s.codec = e.target.value; hooks.changed(); } } },
               choices, s.codec || ''),
    ];
    // **A mix nothing feeds.** The render drops this stream — native finds out
    // by opening and `streamSpecs()` says the same thing from the probe — so a
    // row that went on stating "the mix, through aac" would be describing a
    // track the file will not have. Said on the row rather than in the warnings
    // list, because that is where the decision it is about was taken.
    //
    // A pad-fed row is outside it, exactly as a copied one is: what feeds it is
    // a chain in libavfilter, and a timeline with nothing audible on it says
    // nothing about whether that chain produces samples.
    if (madeOfTheMix(s) && !hasAudibleSound())
        out.push(span('— nothing on the timeline has a soundtrack, so this stream will ' +
                      'not be written', 'ex-stream-none'));
    // The same sentence about the picture, for a timeline that is only sound.
    if (madeOfTheComposite(s) && !hasVisiblePicture())
        out.push(span('— nothing on the timeline has a picture, so this stream will ' +
                      'not be written', 'ex-stream-none'));
    return out;
}

/// A subtitle row: which track, and what it comes out as.
///
/// **Carrying and converting are one control**, because they are one decision
/// with one question behind it — is the codec that is in the input a codec this
/// container holds? Split across two controls, somebody would set the encoder
/// on a row that is being copied, which is a setting that does nothing, and the
/// application would have to say so afterwards.
function saysSubtitle(s) {
    const choices = subtitleChoices();
    const picker = select({ cls: 'ex-stream-src', 'data-f': 'stream-source',
                            title: 'Carried through as it is, or decoded and written again',
                            on: { change: (e) => { setSource(s, e.target.value); } } },
                          choices.length ? choices
                                         : [{ id: '', label: 'no subtitle file is open' }],
                          s.source || '');

    const stream = readStream(s);
    if (isCopy(s)) {
        // No encoder, so no menu: what is in the file is what was in the input.
        return [picker, span('·', 'dim'),
                span(`${stream ? stream.codec : 'as it is'}, unchanged`, 'ex-stream-copied')];
    }

    // What the container holds, asked of it. A row is not offered a codec the
    // muxer will refuse, because the refusal would arrive at `write_header` —
    // long after this menu said it was fine.
    const legal = subtitleCodecsOf(settings.container);
    const inherited = defaultSubtitleCodec(settings.container);
    const list = subtitleEncoders().filter((e) => legal.indexOf(e.id) >= 0);
    const options = [{ id: '', label: `${inherited || 'container default'}  (what ` +
                                      `${settings.container} writes)` }]
        .concat(list.map((e) => ({ id: e.id, label: `${e.id} — ${e.label}` })));
    return [
        picker,
        span('as', 'dim'),
        select({ cls: 'ex-stream-codec', 'data-f': 'stream-codec',
                 on: { change: (e) => { s.codec = e.target.value; hooks.changed(); } } },
               options, s.codec || ''),
    ];
}

/// Move a row between the three things it can be fed from.
///
/// The encoder choice is dropped on the way into a copy, because a copied stream
/// has no encoder and a `codec` left on one is refused by the renderer — rightly,
/// since it would be a setting that did nothing. The span is dropped on the way
/// out for the same reason in reverse.
///
/// **A pad-fed row keeps its encoder**, and that is the whole difference between
/// it and a copy: it is an encoded stream whose pictures happen to come from the
/// middle of a graph rather than from the composite. What it drops is the span,
/// which belongs to a row that reads an input and means nothing here.
function setSource(s, source) {
    s.source = source;
    if (isCopy(s)) {
        s.codec = '';
        s.bsf = s.bsf || [];
        s.tag = '';
    } else if (s.kind !== 'subtitle') {
        // A converted subtitle track keeps its window: `copyFrom` says where
        // the reading starts and where the output's zero is, which is the same
        // decision whether the cues are copied or written again. Only a
        // *composed* stream has no window, because its zero is the range's.
        s.copyFrom = 0;
        s.copyTo = 0;
    }
    openDetail = s.id;
    syncAudioFlag();
    hooks.changed();
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
    // The span a copy takes, in the input's own seconds — which is what the
    // renderer is given and what `-ss`/`-to` in the command say. Written before
    // the metadata because it is the part of the sentence that changes what is
    // in the file.
    if (isCopy(s) || (s.kind === 'subtitle' && isDecode(s))) {
        const from = Number(s.copyFrom) || 0;
        const to = Number(s.copyTo) || 0;
        if (from > 0 || to > 0)
            bits.push(`${from.toFixed(2)} s → ${to > 0 ? to.toFixed(2) + ' s' : 'the end'}`);
        else bits.push('all of it');
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
            div('ex-note dim',
                'The reason to embed one is an ASS subtitle track: it names its fonts by ' +
                'name and carries none of them, so a player without that font substitutes ' +
                'and every line of text moves. A font travelling in the file is the only ' +
                'thing that makes styled subtitles look the same anywhere.'),
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
        ...copyRows(s, restate),
        row('Language', [lang, span('ISO 639-2', 'dim')]),
        row('Name', title),
        row('Flags', dispositionToggles(s, restate)),
        ...tagRow(s, restate),
        head('Metadata'),
        ...pairRows(s.metadata, `s${s.id}`, restate),
        ...bsfRows(s, restate),
    ];
}

// ── What a copy takes, and where it can start ──────────────────────────────
//
// **A copy can only begin at a keyframe**, and that is the one fact about the
// packet path a person has to hold. Everything else about a copy is a saving;
// this is the cost, and it is a cost that is invisible until the file is open
// in a player and starts a second and a half early.
//
// So the keyframes are on the screen, as the places they are. The strip is the
// input's own clock with a mark per keyframe, the in-point is drawn against
// them, and clicking a mark is how the cut is snapped to one. Underneath, in
// words, what the current in-point costs — because a strip answers "where" and
// only a sentence answers "and what does that mean".

function copyRows(s, restate) {
    // **A subtitle stream has no keyframes to snap to.** Every cue stands on
    // its own — it is a moment with text on it, not a frame that depends on
    // the one before — so the window is two numbers and there is nothing to
    // draw a strip of. Saying that is better than an empty strip, which reads
    // as a file whose keyframes could not be found.
    if (s.kind === 'subtitle') {
        if (!readsInput(s)) return [];
        const input = readInput(s);
        return [
            head('What is read'),
            row('From', [subNum(s, 'copyFrom', restate),
                         span('seconds into the file', 'dim')]),
            row('To', [subNum(s, 'copyTo', restate), span('0 is the end of it', 'dim')]),
            div('ex-note dim',
                'The start is also the output’s zero: a subtitle file written against a ' +
                'whole programme, read from ten seconds in, comes out ten seconds earlier ' +
                'than it went in. Every cue stands on its own, so unlike a copied picture ' +
                'this can begin anywhere.' +
                (input ? ` Read out of ${input.name}.` : '')),
        ];
    }
    if (!isCopy(s)) return [];

    const list = keyframesFor(s);
    const stream = copiedStream(s);
    const input = copiedInput(s);
    // `lengthOf`, not a copy of it minus a term: an input's length is its video
    // stream's own duration where there is one and the container's otherwise,
    // and a container that reports none where the stream does gave the keyframe
    // strip a span of zero to draw the in-point against.
    const total = input ? inputLength(input) : 0;

    const num = (key, placeholder) => el('input', {
        cls: 'num', 'data-f': `copy-${key}`, type: 'number', min: 0, step: 0.1,
        value: Number(s[key]) || 0, placeholder,
        on: { change: (e) => {
            s[key] = Math.max(0, Number(e.target.value) || 0);
            // Restated first, then redrawn. `restate` closes over the tail of
            // the row it was made for, and `drawStreams()` has just detached
            // it — harmless only because the redraw recomputes the same text,
            // which is not a thing to leave lying about. `bsfRows` already
            // does it this way round.
            restate();
            drawStreams();
        } },
    });

    const out = [
        head('What is copied'),
        row('From', [num('copyFrom', '0'), span('seconds into the input', 'dim')]),
        row('To', [num('copyTo', '0'), span('0 is the end of it', 'dim')]),
    ];

    if (stream && stream.kind === 'audio') {
        out.push(div('ex-note dim',
            'Every packet of a sound stream stands on its own, so a copied soundtrack ' +
            'starts exactly where it is asked to.'));
        return out;
    }

    if (!list || !list.times.length) {
        out.push(div('ex-note dim',
            'Where this stream’s keyframes are could not be read, so the copy will begin ' +
            'at the keyframe at or before the in-point without this being able to say ' +
            'where that is.'));
        return out;
    }

    const want = Number(s.copyFrom) || 0;
    const land = keyframeAtOrBefore(list, want);
    const span0 = Math.max(total, list.times[list.times.length - 1] + 1);

    out.push(row('Keyframes', keyframeStrip(s, list, span0, restate)));
    out.push(div('ex-copy-note' + (land !== null && want - land > 0.001 ? ' warn' : ' dim'),
                 inPointNote(s)));
    if (land !== null && want - land > 0.001)
        out.push(div('ex-add', el('button', {
            cls: 'tiny', text: `Snap to ${land.toFixed(2)} s`, 'data-f': 'copy-snap',
            title: 'Move the in-point to the keyframe the copy would start on anyway',
            on: { click: () => { s.copyFrom = land; restate(); drawStreams(); } },
        })));
    out.push(div('ex-note dim',
        `${list.times.length} keyframe${list.times.length === 1 ? '' : 's'}, from the ` +
        `${list.how === 'index' ? 'demuxer’s own index' : 'packets, read'}` +
        `${list.complete ? '' : ' — and the list was cut short, so there are more'}. ` +
        'A copy is packets, so it can only begin on one of them.'));
    return out;
}

/// One of a subtitle row's two window numbers. The same control the copy rows
/// use, without the strip: there is nothing to snap to.
function subNum(s, key, restate) {
    return el('input', {
        cls: 'num', 'data-f': `copy-${key}`, type: 'number', min: 0, step: 0.1,
        value: Number(s[key]) || 0,
        on: { change: (e) => {
            s[key] = Math.max(0, Number(e.target.value) || 0);
            // `restate` ends in `hooks.restated()` already; saying it twice ran
            // the whole warnings pass twice on every keystroke.
            restate();
        } },
    });
}

/// The input's clock with a mark per keyframe, and the in-point against them.
///
/// Built rather than drawn into a canvas because there are a handful of marks
/// and each one is a thing to click: hit-testing ticks by hand to find out which
/// was meant is work with a DOM node's name on it, which is the same argument
/// the Graph stage's `+` is placed by.
function keyframeStrip(s, list, span0, restate) {
    const want = Number(s.copyFrom) || 0;
    const at = (t) => `${Math.max(0, Math.min(100, (t / (span0 || 1)) * 100))}%`;
    const marks = list.times.map((t) => el('button', {
        cls: 'ex-kf' + (Math.abs(t - want) < 0.001 ? ' on' : ''),
        'data-kf': t.toFixed(3),
        title: `${t.toFixed(2)} s`,
        style: { left: at(t) },
        on: { click: () => { s.copyFrom = t; restate(); drawStreams(); } },
    }));
    return div('ex-kf-strip', [
        div('ex-kf-track', marks),
        el('div', { cls: 'ex-kf-here', style: { left: at(want) } }),
    ]);
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
            restate();
            drawStreams();
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
