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

import { el, div, span, put, select, head, fromTemplate, show } from '../dom.js';
import { basename } from '../format.js';
import { project, hasPicture } from '../project.js';
import { inputs, hasSound } from '../inputs.js';
import { settings, activeVideoCodec, activeAudioCodec } from './state.js';
import { videoEncoders, audioEncoders, muxerInfo } from './capabilities.js';
import { videoOptions, audioOptions } from './options.js';
import { parseCopy, isCopy, copyChoices, copiedStream, copiedInput,
         rewrapRows, timelineSpan, followedClip } from './copy.js';
import { subtitleChoices, subtitleEncoders, subtitleCodecsOf, defaultSubtitleCodec,
         holdsSubtitles, isDecode, readsInput, readStream,
         defaultSubtitleSource } from './subtitles.js';
import { isPad, parsePad, padChoices } from './pads.js';
import { wires as overlayWires } from '../graph/overlay.js';
import {
    bindStreamsDetailContext, setSource, tailOf, detailRows, pairRows, chapterRows,
} from './streams-detail.js';

let host = null;
let hooks = {};

// Which row's detail is open, held by the row's own id rather than by its
// position: removing the row above it would otherwise open a different stream's
// fold, and holding the row object itself would not survive `restore()`.
let openDetail = 0;

// And which *part* of that row. One fold used to mean one row unfolding into
// everything it has — a span, two names, fifteen flags, a metadata bag and a
// packet chain, four hundred and fifty pixels of it — which is the forty
// controls on one screen that the fold exists to prevent, moved one level down
// rather than avoided. So the detail is faceted: the strip says which parts of
// this stream carry anything, and one of them is open.
//
// Module-level and not per row, because only one row is open at a time and
// carrying a facet per stream would mean remembering which tab somebody last
// used on a stream they may since have deleted. Cleared when a different row is
// opened, so a facet a row does not have cannot be inherited from the last one.
let openFacet = '';

let nextId = 100;
const newId = () => ++nextId;

bindStreamsDetailContext({
    openFacet: () => openFacet,
    setOpenFacet: (v) => { openFacet = v; },
    setOpenDetail: (id) => { openDetail = id; },
    syncAudioFlag: () => syncAudioFlag(),
    drawStreams: () => drawStreams(),
    codecOf: (s) => codecOf(s),
    changed: () => hooks.changed && hooks.changed(),
    restated: () => hooks.restated && hooks.restated(),
});

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
                   s.kind !== 'subtitle' && s.kind !== 'data')) continue;
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
        const goneCopy = at && (!inputs[at.input] || !(inputs[at.input].probe || {}).streams);
        // A data row has no composed source to come back as — nothing here
        // makes one — so a row whose input has gone is dropped outright, the
        // way a subtitle row with no track left to read is. Turned into "the
        // mix" it would be a soundtrack somebody never asked for.
        if (s.kind === 'data') {
            if (goneCopy || !at) continue;
        } else if (s.kind !== 'subtitle' && goneCopy) {
            s.source = s.kind === 'video' ? 'composite' : 'mix';
        }
        s.copyFrom = Number(s.copyFrom) || 0;
        s.copyTo = Number(s.copyTo) || 0;
        // The link to the clip this row follows, which is a clip **id** — the
        // same name a document's clip list and the graph's anchors are written
        // against. Two reads go through here and they want opposite things: a
        // document has just put the clips back with their ids, so a link is kept;
        // `localStorage` at boot has no clips beside it at all, so every link is
        // dropped, because clip 7 in the next edit is a different shot. One test
        // answers both, and it is the same test `followedClip()` applies — asked
        // again here rather than trusted, because this blob was written by a
        // version of this code that is not the one reading it.
        if (s.followClip && !followedClip(s)) delete s.followClip;
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

// `D` is ffmpeg's own letter for a data stream — `-c:d`, `-map 0:d:0` — which
// is the point of using these letters at all rather than words.
const KIND_LETTER = { video: 'V', audio: 'A', subtitle: 'S', attachment: 'T', data: 'D' };

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

/// The stream list as the file will have it: one plain line each, in words.
///
/// **The verdict column's job, and it was not doing it.** That column exists so
/// that the last thing under the pointer before the click is a description of
/// what the click does — and what it described was the picture, in two lines,
/// while the answer to "what will be in this file" was a hundred controls in the
/// column beside it. So this is the same list said as statements: what a stream
/// is, where it comes from, what it comes out as, and the words a track menu
/// would show. `says()` is the editable version of the same sentence and this is
/// deliberately not built out of it — one is controls and one is text, and a
/// shared builder would be a `<select>` with no listener on it.
///
/// It is derived on every restate, like the summary above it, so nothing here is
/// remembered and there is no second copy of the list to fall out of step.
export function manifest() {
    const list = settings.streams || [];
    return list.map((s, i) => {
        const label = labelOf(list, i);
        const codec = codecOf(s);
        const copied = copiedStream(s);
        let from = '';
        if (s.kind === 'attachment') from = s.path ? basename(s.path) : 'no file yet';
        else if (copied) {
            const input = copiedInput(s);
            from = `copied${input ? ` from ${input.name}` : ''}`;
        } else if (s.kind === 'subtitle') from = readsInput(s) ? 'read from an input' : 'no source';
        else if (isPad(s)) from = `the graph’s [${parsePad(s.source)}]`;
        else from = s.kind === 'video' ? 'the composite' : 'the mix';
        // The one thing here that is a *refusal* rather than a description: a
        // row the render will drop is a row the file will not have, and the
        // column that says what will be written is exactly where that belongs.
        const dropped = (madeOfTheMix(s) && !hasAudibleSound()) ||
                        (madeOfTheComposite(s) && !hasVisiblePicture());
        // A data stream is named by its **fourcc** and not by its codec, the
        // same way `copyChoices` names one: `gpmd`, `tmcd` and `mebx` all probe
        // as `bin_data`, so the tag is the whole identity of the track and is
        // what the application it is being carried for looks for.
        const named = copied && copied.kind === 'data' ? (copied.tag || codec) : codec;
        return { label, kind: s.kind, codec: copied ? `${named}, as it is` : named,
                 from, tail: tailOf(s), dropped };
    });
}

export function addStream(kind) {
    const s = { id: newId(), kind, metadata: {} };
    if (kind === 'video') s.source = 'composite';
    if (kind === 'audio') s.source = 'mix';
    if (kind === 'attachment') s.path = '';
    // A subtitle row has nothing composed to point at, so it arrives pointing
    // at the first subtitle stream there is — and where there is none, at a cue
    // track of its own, empty, ready to be typed into. That second case is the
    // honest reading of the press: somebody who asked for a subtitle stream with
    // no subtitle file open means to write one, and a row arriving pointed at
    // nothing would be a control to fill in before anything could happen.
    if (kind === 'subtitle') {
        s.source = defaultSubtitleSource(settings.container);
    }
    // A data row is a copy and nothing else, so it arrives pointing at the
    // first data stream there is — for the same reason a subtitle row does,
    // and offered at all only where there is one.
    if (kind === 'data') {
        const first = copyChoices('data')[0];
        s.source = first ? first.id : '';
    }
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
        // The same for a data row somebody added and has not pointed anywhere:
        // `render.start` refuses one by name, and a refusal about a row nobody
        // can see is a refusal about the form rather than about the file.
        if (s.kind === 'data' && !isCopy(s)) continue;
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
        // The stage's master ⓘ rides on this column's heading rather than on
        // the first one's, because this is the column with the room in it and
        // the one somebody is looking at when they want to know what a control
        // is for. It is a stage-level control on a column-level heading, which
        // is a compromise and is better than a bar of chrome above three
        // columns that would then be there on every stage that has none.
        el('div', { cls: 'section-head ex-head' },
           [span(`Streams · ${list.length}`, 'ex-head-t')]),
        div('ex-streams-list', list.map((s, i) => streamRow(list, s, i))),
        ...addRow(),
        ...rewrapRow(),
        ...listSection('chapters', 'Chapters', settings.chapters.length, chapterRows),
        ...listSection('file-metadata', 'File metadata', Object.keys(settings.metadata).length,
            () => pairRows(settings.metadata, 'file', () => hooks.restated())),
    ]);
}

const unfolded = { chapters: false, 'file-metadata': false };

function listSection(key, title, count, build) {
    const empty = count === 0;
    const open = !empty || unfolded[key];
    const opts = { cls: 'section-head ex-head', 'data-f': key };
    if (empty) {
        opts.cls += ' ex-toggle';
        opts.on = { click: () => { unfolded[key] = !unfolded[key]; drawStreams(); } };
    }
    return [
        head(`${empty ? (open ? '▾ ' : '+ ') : ''}${title} · ${count}`, opts),
        ...(open ? build() : []),
    ];
}

/// The four kinds of stream that can be added, and the reason a kind is missing.
///
/// **A refusal goes under the buttons and never among them.** `.ex-add` is a
/// flex row, so a paragraph returned in place of a button became a *flex item* —
/// three lines of prose wedged between `+ Subtitle` and `+ Attachment`, shoving
/// the last button to the far margin. It looked like a rendering fault and it
/// was a shape mismatch: a button and a sentence are not two of the same thing
/// and cannot be laid out as though they were.
function addRow() {
    const sub = holdsSubtitles(settings.container);
    const data = copyChoices('data').length > 0;
    // Said only where somebody has opened something, so an empty stage is not
    // lectured about a stream kind it has no file to have one of.
    const opened = inputs.some((i) => i && i.probe);
    return [
        div('ex-add', [
            addButton('Video', 'video'),
            addButton('Audio', 'audio'),
            // **A subtitle button that is absent is worth a sentence**, for the
            // reason it always was: a stage with no subtitle control on it reads
            // as an application that cannot write subtitles at all.
            sub ? addButton('Subtitle', 'subtitle') : null,
            // **A data stream cannot be made**, only carried, so the only
            // question is whether one of the open inputs has one. A button that
            // added a row with nowhere to point would offer a stream that
            // cannot exist.
            data ? addButton('Data', 'data') : null,
            addButton('Attachment', 'attachment'),
        ]),
        // Both of these are cut to the refusal itself, which is the part that
        // is true of *this* stage right now. Where each stream kind can come
        // from instead is in the manual, and a paragraph of it under a row of
        // buttons was the largest block of text on the screen.
        sub ? null : div('ex-note dim',
            `The ${settings.container} muxer holds no subtitle codec this build can write. ` +
            'Matroska holds ass, subrip and webvtt; mp4 holds mov_text — or burn them into ' +
            'the picture with a subtitles filter on the Graph stage, which any container ' +
            'takes.'),
        (data || !opened) ? null : div('ex-note dim',
            'No open input has a data stream — telemetry, timecode, timed metadata — so ' +
            'there is none to carry through, and one cannot be made here.'),
    ];
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
    const buttons = [];
    for (const input of usable) {
        const index = inputs.indexOf(input);
        buttons.push(el('button', {
            cls: 'tiny', text: `Rewrap ${input.name}`,
            'data-rewrap': input.id,
            title: 'Rewrap',
            on: { click: () => rewrap(index, null) },
        }));
        // **The lossless cut, which is a rewrap with the edit's span on it.**
        // Offered only where the timeline says something a whole-file rewrap
        // does not: a clip nobody has trimmed describes the same file, so a
        // second button beside the first would be two names for one operation.
        const sp = timelineSpan(index).span;
        if (sp && !sp.whole)
            buttons.push(el('button', {
                cls: 'tiny', text: `Cut ${input.name}`,
                'data-cut': input.id,
                title: 'Lossless cut',
                on: { click: () => rewrap(index, sp) },
            }));
    }
    return [
        head('Copy it instead'),
        div('ex-add', buttons),
    ];
}

function rewrap(index, span) {
    const rows = rewrapRows(index, newId, span);
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

/// The same rewrap, asked for from somewhere that is not this stage.
///
/// **Because a download is a render and this application has one of those.** A
/// stream pulled off a page is copied to a local file by writing every packet
/// into a container without decoding it, which is exactly what `Rewrap` above
/// does — so the press on the Sources stage sets this list up and walks here
/// rather than growing a second copy path with its own progress, its own job
/// slot and its own idea of what a container will hold. What you land on is an
/// ordinary stream list you can read, change and undo before pressing Render.
///
/// **The data streams are dropped, and that is not a shortcut.** Twitch's HLS
/// carries a `timed_id3` track of its own segment metadata; Matroska will not
/// hold a data stream and says so, and the track means nothing once the
/// recording is off Twitch. Keeping it would mean choosing a container to suit a
/// track nobody pulling a VOD came for. They are dropped by *kind* and the count
/// is returned, so the caller can say what it left out rather than the list
/// quietly being shorter than the file.
///
/// **Every row arrives closed, which is where this differs from `rewrap` above
/// and is not a detail.** The open detail of a copied *video* row draws the
/// keyframe strip, and drawing it means asking where the keyframes are — which
/// for a container with no index is a read of the file, and for an input that is
/// a URL is a download (`keyframesFor` in copy.js has the measurement). `Rewrap`
/// opens the first row because somebody pressed it on this stage and is looking
/// at the list; this press was made on the Sources stage about a file, and the
/// stage it lands on should cost what walking to a stage costs.
///
/// Returns `{ ok, dropped, rows }` — `ok` false when nothing in the input can be
/// copied at all, which is an input that failed to open.
export function copyOfInput(index, span, opts = {}) {
    const rows = rewrapRows(index, newId, span || null);
    if (!rows.length) return { ok: false, dropped: 0, rows: 0 };
    const kept = opts.keepData ? rows : rows.filter((s) => s.kind !== 'data');
    settings.streams = kept;
    if (opts.container) settings.container = opts.container;
    if (opts.path) settings.path = opts.path;
    openDetail = 0;
    syncAudioFlag();
    return { ok: true, dropped: rows.length - kept.length, rows: kept.length };
}

function addButton(label, kind) {
    return el('button', {
        cls: 'tiny', text: `+ ${label}`, 'data-add': kind,
        title: kind === 'attachment'
            ? 'A file that travels inside the output — a font, a cover image'
            : kind === 'subtitle'
                ? 'A subtitle track in the output, carried through or converted'
                : kind === 'data'
                    ? 'A timed data track carried straight through — telemetry, timecode'
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
        // A different row is a different set of facets — a data stream has no
        // packet chain and an attachment has none of them — so the strip starts
        // at its own first entry rather than at whichever one the last row was
        // left on.
        openFacet = '';
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

    // **A data row has one answer and it is not a choice between kinds.**
    // There is no composed data stream and no encoder for one, so the sentence
    // is "which track" and then a statement: the fourcc, because that is the
    // whole identity of the stream and `bin_data` is what all of them are
    // called. Drawing the codec menu disabled beside it would say a choice was
    // being withheld, and there is none to withhold.
    if (s.kind === 'data') return saysData(s);

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
                            title: 'Stream source',
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
                            title: 'Subtitle source',
                            on: { change: (e) => { setSource(s, e.target.value); } } },
                          choices, s.source || '');

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

/// A data row: which track, carried as it is.
///
/// The fourcc is stated rather than the codec name for the reason `copyChoices`
/// offers it — `gpmd`, `tmcd` and `mebx` are all `bin_data`, and the tag is
/// what the application this track is being carried for looks for.
function saysData(s) {
    const choices = copyChoices('data');
    const picker = select({ cls: 'ex-stream-src', 'data-f': 'stream-source',
                            title: 'Data stream',
                            on: { change: (e) => { setSource(s, e.target.value); } } },
                          choices.length ? choices.map((c) => ({ id: c.id, label: c.label }))
                                         : [{ id: '', label: 'no data stream is open' }],
                          s.source || '');
    // The picker already names the tag, so the statement beside it says what
    // happens to the track rather than repeating what it is.
    return [
        picker,
        span('·', 'dim'),
        span('carried through untouched', 'ex-stream-copied'),
    ];
}
