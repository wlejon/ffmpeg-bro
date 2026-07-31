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

import { el, div, span, put, select, row, segmented, fromTemplate, show } from '../dom.js';
import { basename } from '../format.js';
import { project, hasPicture } from '../project.js';
import { inputs, hasSound, lengthOf as inputLength } from '../inputs.js';
import { settings, activeVideoCodec, activeAudioCodec } from './state.js';
import { videoEncoders, audioEncoders, muxerInfo, dispositions,
         codecTags } from './capabilities.js';
import { videoOptions, audioOptions } from './options.js';
import { optionColumn } from '../opttable.js';
import { parseCopy, isCopy, copyChoices, copiedStream, copiedInput,
         keyframesFor, keyframeAtOrBefore, inPointNote, rewrapRows,
         timelineSpan, clipSpan, followedClip, follow, unfollow,
         brokeFollowing } from './copy.js';
import { subtitleChoices, subtitleEncoders, subtitleCodecsOf, defaultSubtitleCodec,
         holdsSubtitles, isDecode, readsInput, readStream, readInput,
         defaultSubtitleSource, cuesFor, cueWindow, cueWindowNote,
         cueTextFor, cueSaying, parseCueTrack, isCueRow, cueSource } from './subtitles.js';
import { cueTracks, trackById as cueTrackById, makeCueTrack, forkFrom, forkRefusal,
         hasOverrides, fileExtension, cueFilePath, cuesChanged } from '../cues.js';
import { goTo } from '../shell.js';
import { isPad, parsePad, padChoices } from './pads.js';
import { explained, why, whyButton, explainAllButton, onExplainChange } from './explain.js';
import { wires as overlayWires } from '../graph/overlay.js';

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

export function initStreams(node, h) {
    host = node;
    hooks = h || {};
    // Pressing an ⓘ anywhere on the stage redraws this column, because the ⓘ on
    // a stream row's facet strip is drawn by this module and the master one puts
    // paragraphs back into every section of it at once.
    onExplainChange(() => drawStreams());
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
        // A row reading the document's own cues names a track by **id**, which is
        // the same kind of name a followed clip is and gets the same two-way
        // answer: after a document has been opened the tracks are there and the
        // link is kept; at boot, out of `localStorage`, there are none beside it
        // and every such row goes — because cue track 3 in the next edit is
        // somebody else's dialogue. Dropped outright rather than repointed at a
        // file, the way a data row is: there is no file this row was ever about.
        const cueId = s.kind === 'subtitle' ? parseCueTrack(s.source) : null;
        if (cueId !== null && !cueTrackById(cueId)) continue;
        // A subtitle row reads an input and there is no composed source to fall
        // back to, so a row whose input has gone takes the first subtitle
        // stream that is still there — and is dropped when there is none. It
        // cannot become "the mix" the way a stale copy of a soundtrack can.
        if (s.kind === 'subtitle' && cueId === null) {
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
        } else if (isCueRow(s)) from = 'cues in this document';
        else if (s.kind === 'subtitle') from = readsInput(s) ? 'read from an input' : 'no source';
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
        if (!s.source) {
            s.source = cueSource(makeCueTrack({ name: 'Cues' }).id);
            cuesChanged();
        }
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
        // the renderer would only say it about a form nobody can see. A row
        // reading the document's own cues reads no input *yet* — `attachCueFiles`
        // in export/spec.js gives it one — so it is the one subtitle row that
        // legitimately passes this test with nothing behind it.
        if (s.kind === 'subtitle' && !readsInput(s) && !isCueRow(s)) continue;
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
           [span('What is in the file', 'ex-head-t'), explainAllButton()]),
        div('ex-streams-list', list.map((s, i) => streamRow(list, s, i))),
        ...addRow(),
        ...rewrapRow(),
        ...listSection('chapters', 'Chapters', settings.chapters.length, chapterRows,
            'Beside the streams rather than among them, because a chapter is not one: it has ' +
            'no index, nothing is mapped to it, no player shows it in a track menu and there ' +
            'is no -metadata:s: for one. It is a table in the container — marks on the ' +
            'output’s own timeline.',
            'Drawn as a row in the list above it would invite the question “what is chapter ' +
            '2’s language”, which has no answer.'),
        // Its own key rather than the stream facet's: they are the same idea one
        // level apart, and an ⓘ pressed on a stream's metadata should not put a
        // paragraph at the bottom of the column about the container's.
        ...listSection('file-metadata', 'File metadata', Object.keys(settings.metadata).length,
            () => pairRows(settings.metadata, 'file', () => hooks.restated()),
            '-metadata key=value, on the container rather than on a stream — a title, an ' +
            'author, a comment. Two fields rather than one line to be parsed, because a ' +
            'value is free to contain anything and a single field holding a=b;c=d would need ' +
            'an escaping rule this application has nowhere else.'),
    ]);
}

// Which of the two lists at the bottom of this column somebody has opened while
// it is empty. Not in `settings` and not in the workspace, for the reason the
// muxer picker's own state is not: it is where you are, not what will be
// written, and a document carrying it would be a document that reformatted
// somebody else's stage.
const unfolded = { chapters: false, 'file-metadata': false };

/// A section that is a list, drawn as one line while there is nothing in it.
///
/// **The stream list is the subject of this column and the other two are not.**
/// Drawn open, `Chapters` and `File metadata` were headings of exactly the same
/// weight as `What is in the file`, each with one empty control under it: four
/// equal peers, of which one is what the stage is for and two are empty on
/// nearly every render. Closed they carry their count, which is what makes the
/// line a summary rather than a hiding place — the rule a stream row's facet
/// tabs already follow, and the shape `Also write · 0` has in the band above.
///
/// **A list with anything in it is always open, and its heading is then not a
/// control at all** — which is `versionRows`'s rule, and is why there is no
/// third state to hold. A chapter you have just added that folded itself away
/// would be the application hiding what you did; a heading that still offered
/// the press and did nothing with it would be worse, being a control that looks
/// like one. So the disclosure is there only while there is something to
/// disclose.
function listSection(key, title, count, build, ...prose) {
    const empty = count === 0;
    const open = !empty || unfolded[key];
    const opts = { cls: 'section-head ex-head', 'data-f': key };
    if (empty) {
        opts.cls += ' ex-toggle';
        opts.on = { click: () => { unfolded[key] = !unfolded[key]; drawStreams(); } };
    }
    return [
        explained(key, `${empty ? (open ? '▾ ' : '▸ ') : ''}${title} · ${count}`, opts),
        ...(open ? build() : []),
        why(key, ...prose),
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
            title: 'Every stream of this input, copied — no decode, no encode, ' +
                   'the same bytes in a different container',
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
                title: `Every stream of this input, copied over the span the clip on the ` +
                       `timeline takes — ${sp.from.toFixed(2)} to ${sp.to.toFixed(2)} s — and ` +
                       `each row following that clip, so trimming it again moves the cut`,
                on: { click: () => rewrap(index, sp) },
            }));
    }
    return [
        explained('rewrap', 'Copy it instead'),
        div('ex-add', buttons),
        why('rewrap',
            'A copied stream is the packets that are already in the file: instant, ' +
            'lossless, and untouched by anything on the Compose or Graph stages. ' +
            'A cut can only start at a keyframe — open a row to see where they are. ' +
            'A cut follows the clip it was taken from until you tell it to stop.'),
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
    // Three kinds of answer in one menu, because they are one decision: where do
    // this row's cues come from. The two file answers are `subtitleChoices()`;
    // the third is the document's own tracks, and one more entry that *makes*
    // one. Offering "type them here" even with no file open is the point — a
    // person with no subtitles at all and a line to write starts there.
    const choices = subtitleChoices()
        .concat(cueTracks.map((t) => ({
            id: cueSource(t.id),
            label: `edit — ${t.name} · ${t.cues.length} cue${t.cues.length === 1 ? '' : 's'} ` +
                   'in this document',
        })))
        .concat([{ id: NEW_CUES, label: 'type them here — a new track of your own' }]);
    const picker = select({ cls: 'ex-stream-src', 'data-f': 'stream-source',
                            title: 'Carried through as it is, decoded and written again, or ' +
                                   'a track of cues this document holds',
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
                            title: 'Which data track is carried through',
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
/// The menu entry that is not a source but a press: make a track and read it.
///
/// A sentinel in the list rather than a button beside it, because "where do these
/// cues come from" is one question and a second control for one of its answers
/// would read as a second question. `setSource` turns it into a real `cues:<id>`
/// before anything else sees it, so nothing downstream ever meets this string.
const NEW_CUES = 'cues:new';

function setSource(s, source) {
    if (source === NEW_CUES) {
        const track = makeCueTrack({ name: 'Cues' });
        source = cueSource(track.id);
        // On the model's channel, because a track is the edit: this is the one
        // press on this stage that makes an undo step on the *other* history
        // track, and it is right that it does — the cues are content.
        cuesChanged();
    }
    s.source = source;
    // A row reading the document's cues has no window: `cueFileText` has already
    // put them on the output's clock and clamped them, so a `-ss` in front of the
    // `-i` would move every cue twice. See `attachCueFiles` in export/spec.js,
    // which zeroes these again on the way to the renderer whatever is here.
    if (isCueRow(s)) { s.copyFrom = 0; s.copyTo = 0; }
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
    // **And back to the first facet, because the source is what decides there is
    // one.** Moving a row onto a copy is what gives it a span to trim and a
    // keyframe list to trim against; leaving the strip on whichever tab the last
    // row was open at would hide the one thing this press just made relevant.
    openFacet = '';
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

// ── the facets of one stream ───────────────────────────────────────────────
//
// A stream has five kinds of thing to say about it and they are independent:
// what part of the source it takes, what it is called, what a player should do
// with it, what travels beside it, and what happens to its packets on the way
// to the muxer. Nobody edits two of them at once — a language and a bitstream
// filter have nothing to do with each other — so they are drawn one at a time.
//
// **The strip says which of them carry anything**, which is the half of this
// that is worth more than the height it saves: `Flags · 2` on a closed facet is
// the answer to "what has been set on this row" without opening any of them,
// and the row's own tail already says *what* those two are.

/// The facets this row has, in the order they are decided in.
///
/// A kind that cannot have one does not get an empty tab: a data stream has no
/// packet chain, because a bitstream filter reworks a *codec's* packets and a
/// track nothing decodes has no codec for one to be written against.
function facetsOf(s) {
    const out = [];
    const span = spanFacet(s);
    if (span) out.push(span);
    out.push({ v: 'naming', l: 'Naming', title: 'Language, the name a track menu shows, ' +
                                                 'and the fourcc the muxer writes' });
    out.push({ v: 'flags', l: 'Flags', title: 'What a player should do with this stream ' +
                                              'without being asked' });
    out.push({ v: 'metadata', l: 'Metadata', title: '-metadata:s: on this stream' });
    if (s.kind !== 'data')
        out.push({ v: 'packets', l: 'Packets', title: 'Bitstream filters — the one stage ' +
                                                      'that is neither an encoder nor a muxer' });
    return out.map((f) => {
        const n = facetCount(s, f.v);
        return n ? Object.assign({}, f, { l: `${f.l} · ${n}` }) : f;
    });
}

/// The first facet, which is a window on the source and is not always there: a
/// composed stream takes the whole render range and has nothing to trim.
function spanFacet(s) {
    if (s.kind === 'subtitle') {
        if (isCueRow(s)) return { v: 'span', l: 'Cues',
                                  title: 'The cues this document holds, and what is written' };
        if (!readsInput(s)) return null;
        return { v: 'span', l: 'Cues', title: 'What part of the track is read, and which ' +
                                              'cues survive it' };
    }
    if (!isCopy(s)) return null;
    return { v: 'span', l: 'Span', title: 'What part of the input is copied, and where a ' +
                                          'copy is allowed to begin' };
}

/// How many things are set on a facet, for the badge on its tab.
function facetCount(s, id) {
    switch (id) {
        case 'naming': return [s.language, s.title, s.tag].filter(Boolean).length;
        case 'flags': return (s.disposition || '').split(/[+, ]+/).filter(Boolean).length;
        case 'metadata': return Object.keys(s.metadata || {}).length;
        case 'packets': return (s.bsf || []).filter((b) => b.name).length;
        default: return 0;
    }
}

function detailRows(s, tail) {
    const restate = () => { tail.textContent = tailOf(s); hooks.restated(); };

    // **An attachment is not faceted**, because it has one control. It is a
    // stream with no packets in it — nothing to trim, nothing to filter, and a
    // disposition on a font is a disposition nothing reads — so a strip of five
    // tabs over one field would be the shape of the thing lying about it.
    if (s.kind === 'attachment') {
        const mime = el('input', {
            cls: 'wide', 'data-f': 'attach-mime', type: 'text', value: s.mimeType || '',
            placeholder: 'guessed from the name',
            on: { change: (e) => { s.mimeType = e.target.value.trim(); restate(); } },
        });
        return [
            div('ex-facets', [span('Attachment', 'ex-facet-one'), whyButton('attachment')]),
            row('Mime type', mime),
            why('attachment',
                'An attachment is a stream with no packets in it: the muxer writes the whole ' +
                'file out of the stream at header time, which is what ffmpeg’s -attach does. ' +
                'Matroska holds them; mp4 does not.',
                'The reason to embed one is an ASS subtitle track: it names its fonts by ' +
                'name and carries none of them, so a player without that font substitutes ' +
                'and every line of text moves. A font travelling in the file is the only ' +
                'thing that makes styled subtitles look the same anywhere.'),
        ];
    }

    const facets = facetsOf(s);
    const cur = facets.find((f) => f.v === openFacet) || facets[0];
    return [
        div('ex-facets', [
            segmented('facet', facets, cur.v, (v) => { openFacet = v; drawStreams(); }),
            whyButton(cur.v),
        ]),
        ...facetRows(s, cur.v, restate),
    ];
}

function facetRows(s, id, restate) {
    switch (id) {
        case 'span': return copyRows(s, restate);
        case 'naming': return namingRows(s, restate);
        case 'flags': return [
            row('Flags', dispositionToggles(s, restate)),
            why('flags',
                'libavformat’s own vocabulary, walked bit by bit with av_disposition_to_string ' +
                'rather than written down here. Several at once, because a stream can be ' +
                'forced *and* a commentary — what is stored is +forced+comment, which is ' +
                'exactly what -disposition takes.'),
        ];
        case 'metadata': return [
            ...pairRows(s.metadata, `s${s.id}`, restate),
            why('metadata',
                '-metadata:s: on this stream. Two fields rather than one line to be parsed, ' +
                'because a value is free to contain anything and a single field holding ' +
                'a=b;c=d would need an escaping rule this application has nowhere else.'),
        ];
        case 'packets': return bsfRows(s, restate);
    }
    return [];
}

/// What the stream is called, and what the muxer writes as its fourcc.
function namingRows(s, restate) {
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
        ...tagRow(s, restate),
        why('naming',
            'The name is what a track menu shows and the language is what a player picks by, ' +
            'so a file with two soundtracks and neither of them named is a file whose track ' +
            'menu reads “Audio 1, Audio 2”.',
            'The fourcc is offered as the muxer’s own vocabulary rather than as four ' +
            'characters nobody knows to type — hvc1 and hev1 are the same HEVC bitstream and ' +
            'only the first plays on Apple hardware. A container with nothing to say about ' +
            'this codec shows no such control at all.'),
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
    // **A subtitle stream has no keyframes**, and for a while that was taken to
    // mean there was nothing to draw a window against. Every cue does stand on
    // its own — a moment with text on it, not a frame that depends on the one
    // before — but where those moments *are* is exactly what the two numbers
    // have to be read against, and a copy and a conversion cut differently out
    // of the same pair. So the cues are on screen, as the places they are.
    if (s.kind === 'subtitle') {
        if (isCueRow(s)) return editedCueRows(s);
        if (!readsInput(s)) return [];
        const input = readInput(s);
        return [
            row('From', [subNum(s, 'copyFrom', restate),
                         span('seconds into the file', 'dim')]),
            row('To', [subNum(s, 'copyTo', restate), span('0 is the end of it', 'dim')]),
            ...cueRows(s, restate),
            ...forkRow(s),
            why('span',
                'The start is also the output’s zero: a subtitle file written against a ' +
                'whole programme, read from ten seconds in, comes out ten seconds earlier ' +
                'than it went in.' + (input ? ` Read out of ${input.name}.` : '')),
        ];
    }
    if (!isCopy(s)) return [];

    const stream = copiedStream(s);
    const input = copiedInput(s);
    // **A data stream is not asked where its keyframes are.** Every sample
    // stands on its own — there is no prediction in a track nothing decodes —
    // so the answer is always "all of them" and asking costs a scan of the file
    // for a strip that would say nothing.
    const isData = !!stream && stream.kind === 'data';
    const list = isData ? null : keyframesFor(s);
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
        row('From', [num('copyFrom', '0'), span('seconds into the input', 'dim')]),
        row('To', [num('copyTo', '0'), span('0 is the end of it', 'dim')]),
        ...followRow(s, restate),
    ];

    if (isData) {
        out.push(why('span',
            'Every sample of a data stream stands on its own, so this starts exactly where ' +
            'it is asked to. What the samples mean is the reading application’s business — ' +
            'they are carried through untouched and nothing here interprets them, which is ' +
            'why the span is the only thing there is to decide.'));
        return out;
    }

    if (stream && stream.kind === 'audio') {
        out.push(why('span',
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
    // The count is a fact about *this* stream and stays; why it constrains
    // anything is the same sentence on every file and folds.
    out.push(div('ex-note dim',
        `${list.times.length} keyframe${list.times.length === 1 ? '' : 's'}, from the ` +
        `${list.how === 'index' ? 'demuxer’s own index' : 'packets, read'}` +
        `${list.complete ? '' : ' — and the list was cut short, so there are more'}.`));
    out.push(why('span',
        'A copy is packets rather than pictures, so it can only begin on one of them: a ' +
        'frame between two keyframes is decoded from the one before it and there is nothing ' +
        'to hand a decoder that starts there.'));
    return out;
}

/// `Follow the clip`, which is how a lossless cut stops being read off a strip
/// and typed in by hand.
///
/// **The one thing on this stage that connects a copy to the edit.** Everything
/// else about a copied row is deliberately unreachable from the timeline — a
/// crop, a filter and a second clip are all refused rather than approximated,
/// because none of them can reach packets that are never decoded. The *span*
/// is the exception and always was: trimming a clip and copying a span are the
/// same decision said twice, on the same clock, and until this existed the
/// second one had to be typed from the first.
///
/// **It is a link now, and this is the part of it that is on the screen.** It was
/// a press for a while, and the argument against a binding was that it would be a
/// second source of truth for `copyFrom` and a hidden mode to be in or out of.
/// The first half is still true and is still honoured — a followed row's two
/// numbers are written into the row, so nothing downstream can tell one from a
/// typed one; see `syncFollowing` in copy.js. The second half is what these two
/// lines answer: a bound row **names the clip it follows** and offers to stop, and
/// stopping leaves the numbers exactly where they are, because breaking a link is
/// not undoing a trim.
///
/// Offered for an untrimmed clip too, which the press was not. Two numbers naming
/// the whole input said nothing a bare `0, 0` did not already say, so there was
/// nothing to take; a link made *before* the trim is the case a link is for.
function followRow(s, restate) {
    const at = parseCopy(s.source);
    if (!at) return [];

    const bound = followedClip(s);
    if (bound) {
        const held = clipSpan(bound);
        return [
            row('Following', [
                span(`${bound.name} · ${held.from.toFixed(2)} → ${held.to.toFixed(2)} s`, 'mono'),
                el('button', {
                    cls: 'tiny', 'data-f': 'copy-unfollow', text: 'Stop following',
                    title: 'Leave these two numbers exactly where they are and stop taking ' +
                           'them from the clip',
                    on: { click: () => { unfollow(s); restate(); drawStreams(); } },
                }),
            ]),
            why('span',
                'Trim, move or ripple that clip and this span moves with it — it is the ' +
                'clip’s in and out points on the input’s own clock, which is the same clock ' +
                'these two fields are on. Stop following and the numbers stay where they ' +
                'are: breaking the link is not undoing the trim.'),
        ];
    }

    // A link that broke, said where it cannot be shouted over. The act that
    // breaks one is nearly always a deletion, and a deletion says "Removed
    // landscape.mp4" of its own accord a moment later — so the flash is the notice
    // and this is the record of it.
    const lost = brokeFollowing(s)
        ? el('div', { cls: 'ex-copy-note warn', 'data-f': 'copy-broke', text:
              'This row was following a clip on the timeline and that clip has gone. The two ' +
              'numbers above are the ones it last took, unchanged — breaking a link is not ' +
              'undoing the trim — so what is copied is still what it says.' })
        : null;

    const { span: sp, reason } = timelineSpan(at.input);
    if (!sp)
        return [lost, reason ? div('ex-note dim',
                                   `The clip’s own span is not offered: ${reason}.`) : null];
    const already = Math.abs((Number(s.copyFrom) || 0) - sp.from) < 0.001 &&
                    Math.abs((Number(s.copyTo) || 0) - sp.to) < 0.001;
    return [
        lost,
        div('ex-add', el('button', {
            cls: 'tiny', 'data-f': 'copy-follow',
            text: `Follow the clip (${sp.from.toFixed(2)} → ${sp.to.toFixed(2)} s)`,
            title: 'Take the in and out points from the clip on the timeline, and keep ' +
                   'taking them — the same clock, so the numbers go across unchanged',
            on: { click: () => { follow(s, sp.clip); restate(); drawStreams(); } },
        })),
        // What the press is about *now*: the numbers may already be these ones,
        // and following is still worth pressing, because what it adds is that
        // they stay these ones. A statement about this row's current numbers, so
        // it stays — cut to the one clause that says why the button is still
        // worth pressing, which is the whole of what somebody looking at a
        // button that appears to do nothing needs.
        already
            ? div('ex-note dim',
                  'Already the numbers that clip says — following keeps them so when it ' +
                  'is trimmed again.')
            : sp.whole
                ? div('ex-note dim',
                      'That clip is the whole input — following changes nothing until it ' +
                      'is trimmed.')
                : null,
    ];
}

/// One of a subtitle row's two window numbers. The same control the copy rows
/// use, and now with the same redraw: the cues below are drawn against this
/// number, so a window typed rather than clicked has to repaint them or the
/// marks go on describing the previous one.
function subNum(s, key, restate) {
    return el('input', {
        cls: 'num', 'data-f': `copy-${key}`, type: 'number', min: 0, step: 0.1,
        value: Number(s[key]) || 0,
        on: { change: (e) => {
            s[key] = Math.max(0, Number(e.target.value) || 0);
            // `restate` ends in `hooks.restated()` already; saying it twice ran
            // the whole warnings pass twice on every keystroke.
            restate();
            drawStreams();
        } },
    });
}

/// The cues, and what this row's window does to them.
///
/// The subtitle answer to the keyframe strip, and drawn as a **list** rather
/// than as a strip on purpose: a cue is a span with a length worth reading, the
/// count is small enough to write out, and the useful question is which of them
/// survive the window rather than where they sit proportionally. Each is a
/// button, because moving the in-point onto a cue is the fix for nearly
/// everything this section has to report.
///
/// **And each says what it says**, which is a second read of the file and is
/// what makes the list answer the question somebody actually has: not "is there
/// a cue at 4.5 s" but "which line am I cutting into". The words come from
/// `cueTextFor` — a decoder per track, alive while this stage is — and where
/// there are none the reason is written in their place, because a `dvdsub` cue is
/// a picture with no characters in it and a blank column would read as a track
/// this panel failed to read.
function cueRows(s, restate) {
    const list = cuesFor(s);
    if (!list)
        return [div('ex-note dim',
                    'Where this track’s cues are could not be read, so what the window does ' +
                    'to them cannot be said here — the render still cuts it the same way.')];
    if (!list.cues.length)
        return [div('ex-note dim', 'This track has no cues in it.')];

    const w = cueWindow(s, list);
    const shown = nearestCues(list.cues, w);
    const kept = new Set(w.kept);
    const first = w.kept.length ? w.kept[0] : null;
    const time = (t) => `${t.toFixed(2)}`;
    // The words, or the reason there are none. Asked once for the whole list
    // rather than per mark: it is one decode of one track, and sixteen calls
    // would be sixteen.
    const words = cueTextFor(s);
    const saying = words && words.textSub ? words : null;

    const marks = shown.map((c) => {
        const said = saying ? cueSaying(saying, c.start) : '';
        const when = c.end > c.start + 1e-6 ? `${time(c.start)}–${time(c.end)}` : time(c.start);
        const where = kept.has(c)
            ? (c === first ? 'The output starts on this cue' : 'Inside the window')
            : 'Outside the window — start here to take it in';
        return el('button', {
            cls: 'ex-cue' + (c === first ? ' on' : '') + (kept.has(c) ? '' : ' out'),
            'data-cue': c.start.toFixed(3),
            // The whole of it in the tooltip and a line of it on the screen: a
            // cue can be a paragraph, and a list of paragraphs is not a list.
            title: said ? `${when} s\n${said}` : where,
            on: { click: () => { s.copyFrom = c.start; restate(); drawStreams(); } },
        }, said ? [span(when, 'ex-cue-at'), span(oneLine(said), 'ex-cue-said')]
                : [span(when, 'ex-cue-at')]);
    });

    // Laid out as one cue per line where there are words to read and as a
    // wrapped row of times where there are not, which is the same list either
    // way — the times are what a `dvdsub` track has and they still snap.
    const out = [row('Cues', div('ex-cues' + (saying ? ' words' : ''), marks))];
    if (words && !words.textSub)
        out.push(div('ex-copy-note dim',
            `This track is ${words.codec}, which carries pictures of characters rather than ` +
            'characters — so there is nothing to read out of it, and when each picture is on ' +
            'screen is the whole of what can be said about one. It can be carried into a ' +
            'container that holds it; it cannot be converted, and it cannot be burned in, ' +
            'because libavfilter’s subtitles filter is libass and libass reads characters.'));
    else if (!words)
        out.push(div('ex-copy-note dim',
            'What these cues say could not be read. The times are off the packets and are ' +
            'unaffected, so the window still cuts where it says it does.'));
    out.push(div('ex-copy-note' + (w.slip > 0.001 || (w.converting && w.onScreen) ? ' warn' : ' dim'),
                 cueWindowNote(s, list)));

    if (w.converting && w.onScreen)
        out.push(div('ex-add', el('button', {
            cls: 'tiny', text: `Start at ${time(w.onScreen.start)} s`, 'data-f': 'cue-snap',
            title: 'Open the window on the cue that is on screen at the in-point, which a ' +
                   'conversion would otherwise drop',
            on: { click: () => { s.copyFrom = w.onScreen.start; restate(); drawStreams(); } },
        })));
    else if (!w.converting && w.slip > 0.001)
        out.push(div('ex-add', el('button', {
            cls: 'tiny', text: `Snap to ${time(w.zero)} s`, 'data-f': 'cue-snap',
            title: 'Move the in-point to the cue the copy would start on anyway',
            on: { click: () => { s.copyFrom = w.zero; restate(); drawStreams(); } },
        })));

    const total = list.cues.length;
    // What this window does to this track: a count, and how many survive it.
    // Every clause about *why* the count can be known has gone behind the fold.
    out.push(div('ex-note dim',
        `${total} cue${total === 1 ? '' : 's'}` +
        `${list.complete ? '' : ' at least — the list was cut short, so there are more'}. ` +
        (shown.length < total
            ? `${shown.length} are drawn, the ones the window’s ends fall among. `
            : '') +
        `This window keeps ${w.kept.length === total ? 'all of them' : w.kept.length}.`));
    out.push(why('span',
        'The times are off the packets, which is why this can say when a picture track is ' +
        'on screen as readily as a text one' +
        (saying ? ', with the words decoded beside them' : '') + '. Each is a button: ' +
        'moving the in-point onto a cue is the fix for nearly everything this section has ' +
        'to report.'));

    // mp4 fills the gaps between its cues with samples of its own, so a count
    // of packets is not a count of lines. Said where it is true rather than
    // filtered out, because on the packet path those samples are cues: the copy
    // carries them and one of them can be what the window opens on.
    const st = readStream(s);
    if (st && st.codec === 'mov_text')
        out.push(why('span',
            'An mp4 writes an empty sample between one cue and the next, so some of these ' +
            'are the gaps rather than the lines.'));
    return out;
}

// ── taking a file's cues into the document ─────────────────────────────────
//
// **A fork, and the row says so rather than leaving two sources of truth looking
// identical.** Pressing it reads the track through `cueTextFor` — the same
// decoder walk the list above already paid for — and repoints *this row* at the
// document's copy. That in-place repoint is the whole of what stops both copies
// reaching one file: there is never a state where the input's track and the
// edited one are both mapped without somebody having added a second row for the
// second one, which is exactly the explicit act it should be.
//
// The file is not touched, now or ever. See the top of ui/cues.js.

/// `Edit these cues`, or the reason it is not offered.
function forkRow(s) {
    const why = forkRefusal(s);
    if (why)
        return [div('ex-copy-note dim', `These cues cannot be taken into the document: ${why}.`)];
    return [div('ex-add', el('button', {
        cls: 'tiny', text: 'Edit these cues', 'data-f': 'cue-fork',
        title: 'Copy this track’s cues into the document, where they can be typed, ' +
               'retimed on the timeline and split. The file itself is never written to, ' +
               'and this row stops reading it.',
        on: { click: () => {
            // The render's zero on the timeline, asked of the caller rather than
            // imported: `ui/export/spec.js` reads this module for `streamSpecs`,
            // so reading it back would be a cycle for one number.
            const track = forkFrom(s, hooks.renderZero ? hooks.renderZero() : 0);
            if (!track) return;
            setSource(s, cueSource(track.id));
            cuesChanged();
            // Where the lane is, which is the point of the press — the same move
            // `Burn it into the picture` makes towards the Graph stage.
            goTo('compose');
        } },
    }))];
}

/// A row that reads the document's own cues: what is in the track, what will be
/// written, and what it cost to get here.
function editedCueRows(s) {
    const track = cueTrackById(parseCueTrack(s.source));
    if (!track) return [];
    const styled = track.cues.filter(hasOverrides).length;
    const ext = fileExtension(track);
    const name = basename(cueFilePath(track, settings.path || ''));
    const out = [
        div('ex-note',
            `${track.cues.length} cue${track.cues.length === 1 ? '' : 's'} this document holds.`),
        div('ex-add', el('button', {
            cls: 'tiny', text: 'Edit them on the timeline', 'data-f': 'cue-edit',
            on: { click: () => goTo('compose') },
        })),
        why('span',
            'They are edited on the timeline, in the Cues lane under the waveform — which is ' +
            'where a subtitle’s timing is judged, because it is judged by listening.'),
    ];
    if (track.from)
        out.push(div('ex-copy-note dim',
            `Taken out of ${track.name}. That file is no longer read by this row — the ` +
            'document is what renders, and nothing here writes back to it.'));
    // **The render writes a file, and saying so is what keeps the printed command
    // honest.** ffmpeg has no way to receive cues except as one, so this is not a
    // detail of the implementation — it is what the `-i` in the command bar is.
    // **The name of the file the render writes is a statement and stays**, for
    // the reason it was written down at all: ffmpeg has no way to receive cues
    // except as a file, so this is what the `-i` in the command bar *is*, and a
    // printed command naming a file nothing had said would be written is the one
    // thing on this path that would read as a lie.
    out.push(div('ex-note dim',
        `The render writes these into ${name || 'a .' + ext + ' file'} beside the output ` +
        `and reads it back as an ordinary -i, so the command the bar prints runs.`));
    out.push(why('span',
        ext === 'ass'
            ? 'ASS, because that is the format these cues are already in — every text ' +
              'decoder in libavcodec hands over ASS, so the styles and each cue’s own ' +
              'layout came with them and .srt could not carry them back out.'
            : 'SubRip, because a track typed here is words and times and nothing else; ' +
              'wrapping them in a script header would be claiming a look nobody chose.',
        'What the stream in the output comes out as is the container’s question, not this ' +
        'one.'));
    if (styled)
        out.push(div('ex-copy-note warn',
            `${styled} of these cue${styled === 1 ? ' still carries' : 's still carry'} ` +
            'override codes — {\\i1}, {\\pos(…)} — which is styling the file already had. ' +
            'They are written back exactly as they were. Retyping one of those cues drops ' +
            'that cue’s codes, because the whole text field is replaced; its style, layer ' +
            'and margins stay. There is no style editor here, and there is not going to be ' +
            'one: writing an override from a control would be a second opinion about what ' +
            'it means, and libass already has the only one that matters.'));
    return out;
}

/// A cue's words on one line, short enough to sit in a list.
///
/// A cue is two or three lines of dialogue and a `\N` in an ASS one is a break
/// the *author* asked for, so the newlines become a middle dot rather than
/// disappearing: "he said / and then he said" reads as two lines and "he saidand
/// then he said" reads as a typo. Cut at sixty characters, which is about the
/// longest subtitle line anybody writes; the whole of it is in the tooltip.
function oneLine(text) {
    const flat = String(text).replace(/\s*\n\s*/g, ' · ').trim();
    return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/// At most sixteen cues: the ones the window's two ends fall among.
///
/// A whole feature-length track is several hundred, and a panel of several
/// hundred buttons is not a list anybody reads. Cut by *nearness to the two
/// edges* rather than by taking the first sixteen, because the decision this
/// section exists for is always at an edge — and the count above says how many
/// were left out, since a list that quietly stops is one somebody would read
/// the end of as the end of the track.
function nearestCues(cues, w) {
    const CAP = 16;
    if (cues.length <= CAP) return cues;
    const end = w.to > 0 ? w.to : cues[cues.length - 1].start;
    const near = (edge) => cues
        .map((c, i) => ({ i, d: Math.abs(c.start - edge) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, CAP / 2)
        .map((x) => x.i);
    const want = new Set(near(w.from).concat(near(end)));
    return Array.from(want).sort((a, b) => a - b).map((i) => cues[i]);
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
    // Nor a data stream. A bitstream filter reworks a *codec's* packets —
    // every one of them declares which codecs it applies to — and a track
    // nothing decodes has none for a filter to be written against. The list
    // would come back empty, which reads as "none are installed" rather than
    // as "the question does not apply here".
    if (s.kind === 'data') return [];
    if (!s.bsf) s.bsf = [];

    const changed = () => { restate(); drawStreams(); };
    const choices = bsfsFor(codecOf(s));

    // No heading: the facet strip above already says this is the packet chain,
    // and a `.section-head` under it would be the same word twice.
    const rows = [];
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
        `${codecOf(s) || 'this stream'}.`));
    rows.push(why('packets',
        'The rest declare a codec list this stream is not in, asked of each filter’s own ' +
        'codec_ids rather than written down here. They work on packets the encoder has ' +
        'already written, so nothing here costs a re-encode.',
        'The order is the whole of the meaning: h264_mp4toannexb,dump_extra and the same ' +
        'two the other way round are different files. That is why this is a list with arrows ' +
        'rather than a bag of checkboxes.'));
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
