// Cues the document holds, and the file a render writes them into.
//
// Everything else about subtitles in this application reads a file and writes a
// file. This is the one part that *holds* cues: a list of `{ start, end, text }`
// that belongs to the edit, can be typed into, dragged on the timeline, split at
// the playhead, undone, and saved inside a `.fbro`. Four decisions hold it
// together and none of them is negotiable once the first one is taken.
//
// **1. A cue track is the document's, and the source file is never written to.**
// `ui/document.js` `snapshot()`/`open()` is the seam for the whole edit, and cues
// somebody typed are as much the edit as a trim is — so they go there, which buys
// undo (`ui/history.js`'s edit track), a `.fbro` that carries them, and a reconcile
// rather than a rebuild on open. What it deliberately does *not* buy is a writer
// for the file the cues came out of. An editor that rewrites its input is an
// editor that loses work the first time somebody opens the wrong document, and
// this application's whole posture is that inputs are read and the document is
// the edit.
//
// **2. Rendering them means writing a subtitle file, because ffmpeg has no other
// way to receive cues.** There is no `-cue` option and no filter that takes text
// out of thin air; a subtitle stream in an output comes from a subtitle stream in
// an input. So a render materialises the track into a real file and passes it as
// an ordinary `-i`, which is not a compromise — it is the only exact answer, and
// it is what keeps `ui/command.js` honest: the printed command stays *runnable*,
// because the file it names is a file this application actually wrote.
//
// It is written **beside the output and named from the output's name and the
// track's id** — `programme.sub1.ass` — rather than into a temp directory,
// because somebody who pastes the command a day later needs the file to still be
// there, and because an id is stable across renders so a re-render overwrites one
// file instead of littering a directory. A destination that is not a local path
// (a URL, a `tee` list) has nothing to sit beside, and then it goes to the temp
// directory and the command bar says so.
//
// **3. The written file is on the output's own clock.** A track here is in
// *timeline* seconds, because that is the ruler the lane is drawn on and the
// waveform a timing is judged against — and the render's zero is the range's
// start, so the file is written shifted by that, with cues outside the range
// dropped and one straddling the start clamped to zero. The row's window
// (`copyFrom`/`copyTo`) is therefore left at zero: the shifting has already
// happened, in the one place that can also clamp, and a second offset on the `-i`
// would move every cue twice. `-itsoffset` is untouched by all of this and is
// still the right tool for a *file* that is uniformly out.
//
// **4. Forking is explicit, and it is a fork.** `forkFrom()` reads a track's cues
// through `cueTextFor` — the same reader the Write stage's cue list uses, not a
// second one — and from that moment the document is authoritative and the input's
// own track is no longer what renders. The row is repointed in place, so there is
// never a moment where both copies are in the output without somebody having
// asked for both; adding a second row aimed at the file is still possible and is
// exactly the explicit act it should be.
//
// **What that costs, and it is the one thing here that can lose work.** Every
// text decoder in libavcodec hands over ASS, so a forked cue arrives as a
// dialogue line: `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`,
// with `{\i1}` and `{\pos(120,400)}` inside the last field. `cueTextOf` was built
// for a panel and its `text` is the words with all of that taken out — so a fork
// through `text` alone would flatten somebody's styled subtitles silently. That
// is why `cueTextOf` now answers with `raw` and `header` as well (see
// export_subtitle.h): a cue nobody retypes is written back byte for byte,
// including its overrides, and the file's `[V4+ Styles]` goes out in front of
// them. Retyping a cue's words replaces that one Text field — so **that cue's
// own override codes go and its style, layer and margins stay**, which is a real
// loss, is stated per cue by `hasOverrides()`, and is visible before the edit
// rather than discovered after it.
//
// There is deliberately **no style editor**. A cue is text, a start and an end.
// Writing `{\an8}` from a control here would mean a second opinion about what an
// ASS override means, and libass already has the only one that matters.

import { changed } from './project.js';
import { inputs } from './inputs.js';
import { cueTextFor, cueWindow, readsInput, readStream } from './export/subtitles.js';
import { basename } from './format.js';

const fs = require('fs');

/// Every cue track in the edit, in the order they were made.
///
/// A plain array for the reason `ui/inputs.js`'s is: the document writes it in
/// order, an id is what anything else names one by, and a map keyed by id would
/// be a second answer to what order they come back in.
export const cueTracks = [];

// ── ids ────────────────────────────────────────────────────────────────────
//
// The same rule clips and inputs are under, and here for the same reason: a
// stream row on the Write stage says `cues:3`, and an open that renumbered would
// silently point that row at somebody else's dialogue. `useCueId` is how the
// counter is told what a document has already handed out — see `useClipId`.

let nextId = 0;

export function useCueId(id) {
    const n = Math.round(Number(id));
    if (Number.isFinite(n) && n > nextId) nextId = n;
}

export const trackById = (id) => cueTracks.find((t) => t.id === Number(id)) || null;

/// A track of cues, added to the edit.
///
/// `header` is the ASS script header the cues' fields are written against, or ''
/// for a track typed from nothing — and that single field is what decides which
/// *format* the render writes, because it is the whole of the difference between
/// "these cues have a look" and "these cues are words". See `fileExtension`.
export function makeCueTrack(what = {}) {
    const track = {
        id: ++nextId,
        name: String(what.name || 'Cues'),
        // What it was forked from, for the sentence a row shows and for nothing
        // else. Never read to decide anything: the moment a fork has happened the
        // document is authoritative, and a field that could re-point at the file
        // would be the second source of truth the fork exists to remove.
        from: String(what.from || ''),
        header: String(what.header || ''),
        cues: [],
    };
    for (const c of what.cues || []) {
        const cue = readCue(c);
        if (cue) track.cues.push(cue);
    }
    sortCues(track);
    cueTracks.push(track);
    return track;
}

export function removeCueTrack(track) {
    const i = cueTracks.indexOf(track);
    if (i >= 0) cueTracks.splice(i, 1);
}

/// Nothing at all, which is what an `open()` starts from.
export function clearCueTracks() { cueTracks.length = 0; }

/// One cue, sanitised — the reader every path into this module goes through.
///
/// A cue with no length is allowed and a cue with a negative one is not: zero is
/// what a fresh cue at the playhead is for the instant before its end is dragged,
/// and `end < start` is a span nothing can draw. Text is kept verbatim including
/// its newlines, because a two-line cue is two lines the author asked for.
function readCue(c) {
    if (!c || typeof c !== 'object') return null;
    const start = Math.max(0, num(c.start));
    return {
        start,
        end: Math.max(start, num(c.end, start)),
        text: String(c.text === undefined ? '' : c.text),
        raw: String(c.raw || ''),
    };
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/// In time order, always, because three things mean nothing without it: "the next
/// cue" — which is what a merge joins and what `+ Cue` stops against — the
/// numbering a SubRip file is written with, and the order the lane draws them in,
/// which decides which of two overlapping cues is on top and therefore which one
/// a press finds. The sort is stable, so two cues made at the same instant keep
/// the order they were made in.
function sortCues(track) {
    track.cues.sort((a, b) => a.start - b.start);
}

// ── the gestures ───────────────────────────────────────────────────────────
//
// Each of these is model arithmetic and nothing else — no drawing, no announce.
// The caller announces, once, at the end of a gesture, which is the same rule the
// When lane's commit follows: a write per mouse position is sixty undo steps and
// a lane rebuilt under the hand holding it.

/// A new cue over `[start, end]`, in the right place in the list.
///
/// Returns the cue, so a caller can put a cursor in it. `text` is empty on
/// purpose: a new cue that arrived saying "New cue" is a cue somebody has to
/// delete the words out of before typing theirs.
export function addCue(track, start, end, text = '') {
    const cue = readCue({ start, end, text });
    track.cues.push(cue);
    sortCues(track);
    return cue;
}

export function removeCue(track, cue) {
    const i = track.cues.indexOf(cue);
    if (i >= 0) track.cues.splice(i, 1);
}

/// What a cue says, written over it.
///
/// **This is where styling is lost, and it is lost by one cue at a time.** The
/// dialogue line keeps its head — layer, style, name, the three margins, the
/// effect — and its Text field is replaced wholesale, which takes that cue's own
/// override codes with it. Replacing only the words *around* the codes was
/// rejected: it means deciding which `{\k40}` a retyped syllable belongs to, and
/// a karaoke line reassembled by guesswork is worse than one plainly reset.
///
/// `hasOverrides()` is the other half of the same statement and answers off the
/// line rather than off a flag, so a cue stops being marked at the moment its
/// codes actually go and no state has to be kept in step with the text.
export function setCueText(track, cue, text) {
    cue.text = String(text === undefined ? '' : text);
    if (cue.raw) cue.raw = withAssText(cue.raw, assEscape(cue.text));
}

/// Where a cue starts and ends, written over it.
///
/// Clamped rather than refused, because this is what a drag calls: an end pulled
/// through its own start is a hand that has gone too far and not a request for a
/// backwards cue. Ordering is restored here rather than left to the caller — a
/// cue dragged past its neighbour is an ordinary thing to do.
export function setCueTime(track, cue, start, end) {
    cue.start = Math.max(0, num(start, cue.start));
    cue.end = Math.max(cue.start, num(end, cue.end));
    sortCues(track);
}

/// One cue cut in two at `t`, and the second half returned.
///
/// **The words go with the first half and the second starts empty**, which is the
/// only answer that does not invent something. Splitting a cue is what you do
/// when two lines were written as one, and the application cannot know where in
/// the sentence the cut is — so it hands you an empty cue at the right moment,
/// which is a cue to type into rather than a guess to correct. Null when `t` is
/// not strictly inside the cue, because a split at an end is two cues, one of
/// which is nothing.
export function splitCue(track, cue, t) {
    if (!(t > cue.start + 1e-6 && t < cue.end - 1e-6)) return null;
    const second = addCue(track, t, cue.end, '');
    // Its style, not its overrides: the second half is a new line in the same
    // voice, and carrying `{\i1}` across a cut whose text it no longer applies to
    // would be styling nobody asked for.
    if (cue.raw) second.raw = withAssText(cue.raw, '');
    cue.end = t;
    sortCues(track);
    return second;
}

/// Two neighbouring cues made one, and the survivor returned.
///
/// The words are joined with a newline, which is what a two-line cue *is* — and
/// the span runs from the first start to the last end, so a merge over a gap
/// covers the gap. Null when `cue` is the last one, because there is nothing to
/// merge it with; refusing rather than merging backwards keeps the gesture
/// meaning one thing. The words strip does not offer the press in that state at
/// all, which is where that refusal is visible.
///
/// **It goes through `setCueText`, so it costs the overrides**, and that is the
/// rule rather than an oversight: a merge replaces the words, and every override
/// code in an ASS line is positional — `{\i1}` opens italics at the character it
/// stands before. Two lines joined have one set of positions and it is neither
/// cue's. Both cues' styles, layers and margins are the first one's afterwards,
/// which is the same trade retyping makes and is visible the same way: the
/// styled marker on the strip goes when the codes do.
export function mergeCue(track, cue) {
    const i = track.cues.indexOf(cue);
    if (i < 0 || i + 1 >= track.cues.length) return null;
    const next = track.cues[i + 1];
    const joined = [cue.text, next.text].filter((s) => s !== '').join('\n');
    cue.end = Math.max(cue.end, next.end);
    setCueText(track, cue, joined);
    track.cues.splice(i + 1, 1);
    return cue;
}

// ── forking a file's cues into the document ────────────────────────────────

/// Whether a stream row's track can be taken into the document at all.
///
/// **A bitmap track cannot, and the refusal is the one that already exists.**
/// `dvdsub` and `hdmv_pgs_subtitle` are pictures of characters; editing one would
/// be optical character recognition, which is permanently out of scope and is
/// already refused by name for converting and for burning in. `canBurn` is not
/// reused here only because the sentence differs — the property is the same one,
/// `AV_CODEC_PROP_TEXT_SUB`, asked through the probe's `textSub`.
export function forkRefusal(row) {
    const stream = readStream(row);
    if (!readsInput(row) || !stream) return 'this row is not reading a track to take';
    if (stream.textSub === false)
        return `${stream.codec} carries pictures of characters rather than characters, so ` +
               'there is nothing to type into — reading the words out of one would be ' +
               'optical character recognition, which neither this nor ffmpeg does. It can ' +
               'still be carried into a container that holds it, or drawn on the Graph stage';
    return '';
}

/// Take the cues a row reads into the document. Returns the track, or null where
/// `forkRefusal` had something to say or the words could not be read at all.
///
/// **Read through `cueTextFor`, which is the Write stage's own reader.** A second
/// decoder walk here would be a second answer to what a cue says, and the two
/// would drift the first time one of them learned about a format. What this adds
/// is the arithmetic that makes the fork *invisible*: a cue at file second `t`
/// through a row whose window opens at `zero` comes out of the render at `t −
/// zero`, so it goes into the document at `t − zero + at` and the same render
/// writes it in the same place. `cueWindow` is asked which cues survive, for the
/// same reason — one home for a rule the panel already draws.
///
/// `at` is the render's zero on the timeline, handed in rather than read: this
/// module must not import `ui/export/spec.js`, which imports the stream list,
/// which is where the press that calls this lives.
export function forkFrom(row, at = 0) {
    if (forkRefusal(row)) return null;
    const words = cueTextFor(row);
    if (!words || !words.textSub) return null;
    const w = cueWindow(row, { cues: words.cues || [] });
    const kept = w.kept.map((c) => ({
        start: Math.max(0, c.start - w.zero + at),
        end: Math.max(0, c.end - w.zero + at),
        text: c.text,
        raw: c.raw,
    }));
    const input = readsInput(row);
    return makeCueTrack({
        name: nameFor(row),
        from: input ? `${input.input}:${input.stream}` : '',
        header: words.header || '',
        cues: kept,
    });
}

/// What to call a forked track: the file it came out of, since that is how
/// somebody will recognise it in a list of two.
function nameFor(row) {
    const stream = readStream(row);
    const at = readsInput(row);
    const input = at ? inputs[at.input] : null;
    const base = input ? basename(input.path || input.name || '') : '';
    return base || (stream ? stream.codec : 'Cues');
}

// ── an ASS dialogue line, taken apart and put back ─────────────────────────
//
// **The field count is stated in two places and this is the second.**
// `assDialogueText` in src/native/export_subtitle.cpp counts the same fields off
// the front and throws the rest away; this keeps them, because writing the line
// out again is what it is for. They are two questions — *what does this cue say*
// and *what are this cue's fields* — but they are one rule about where the text
// begins, so if one changes the other must.
//
// Two shapes, exactly as over there: the modern
// `ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text` that every
// decoder in this build emits, and the older `Dialogue: Layer,Start,End,…` that a
// file's own `[Events]` section holds. A line with fewer commas than fields is
// not one, and is treated as all text — the same fallback, for the same reason.

const MODERN = 8;
const LEGACY = 9;

/// Where the text of a dialogue line begins, and how many fields precede it.
function assSplit(line) {
    const s = String(line || '');
    let at = 0, fields = MODERN, prefix = false;
    if (s.slice(0, 9) === 'Dialogue:') { at = 9; fields = LEGACY; prefix = true; }
    const heads = [];
    for (let i = 0; i < fields; i++) {
        const comma = s.indexOf(',', at);
        if (comma < 0) return { heads: [], text: s, prefix: false, ok: false };
        heads.push(s.slice(at, comma));
        at = comma + 1;
    }
    return { heads, text: s.slice(at), prefix, ok: true };
}

/// The same line with a different Text field.
function withAssText(line, text) {
    const p = assSplit(line);
    if (!p.ok) return text;
    return `${p.prefix ? 'Dialogue:' : ''}${p.heads.join(',')},${text}`;
}

/// Does this cue still carry override codes — `{\i1}`, `{\pos(…)}`?
///
/// Asked of the line rather than remembered as a flag, so the mark a panel draws
/// goes at the moment the codes do and there is no second piece of state to keep
/// in step. A cue that was never forked has no line and answers false, which is
/// true: nothing typed here writes one.
export function hasOverrides(cue) {
    return !!(cue && cue.raw && assSplit(cue.raw).text.indexOf('{') >= 0);
}

/// Plain text as an ASS Text field: the newlines a person typed become the break
/// the format has. `\N` rather than `\n` because `\n` is a *soft* break libass is
/// allowed to ignore, and a line somebody put a return in is a line they meant.
function assEscape(text) {
    return String(text || '').replace(/\r\n?/g, '\n').replace(/\n/g, '\\N');
}

// ── the file a render writes ───────────────────────────────────────────────

/// Which format this track has to be written in, and it is decided by what the
/// track *holds* rather than by a preference.
///
/// **A forked track is ASS because its cues already are.** Every text decoder in
/// libavcodec hands over ASS — that fact has one home, in export_subtitle.h, and
/// this is a consequence of it — so a track taken out of any subtitle file
/// arrives as dialogue lines against a script header, and `.ass` is the only
/// format that can carry them back out. Writing `.srt` instead would mean
/// deciding what `{\pos(120,400)}` becomes in a format that has no positions,
/// and the answer is that it is thrown away.
///
/// **A typed track is SubRip because it is words and times and nothing else.**
/// Wrapping those in a script header with a `Default` style in it would be
/// claiming a look nobody chose.
///
/// What the *output stream* comes out as is a different question with a different
/// answer, and it is the muxer's: `.srt` becomes `mov_text` in an mp4 and `ass`
/// in Matroska, which is `defaultSubtitleCodec` over `avformat_query_codec` and
/// is unchanged by any of this.
export const fileExtension = (track) => (track && track.header ? 'ass' : 'srt');

/// Whether this build can read back what we would write, by name.
///
/// Asked of libavformat rather than assumed, because that is the rule everywhere
/// here: a file this application writes and hands to `-i` is only useful if there
/// is a demuxer for it, and a build configured without one has to say so rather
/// than fail at open with libav's message about an invalid data stream.
///
/// **Exactly the one named, never a near neighbour.** Answering `srt` for an
/// `.ass` file because the `ass` demuxer is missing would hand a script header to
/// a parser that reads it as three cues with no timing — a render that succeeds
/// and is wrong, which is worse than one that refuses.
export function demuxerFor(ext) {
    return (bro.ffmpeg.demuxers || []).some((d) => d.name === ext) ? ext : '';
}

/// Is there anything of this track inside `[from, to]` to write?
///
/// The cheap form of `cueFileText`, because `buildSpec()` asks on every keystroke
/// and building the whole file to find out whether it is empty is a walk of every
/// cue per character typed. Same three tests, and if one changes both must — the
/// failure being a spec that names a file the writer then declines to write.
export function cuesIn(track, from, to) {
    for (const c of (track && track.cues) || []) {
        if (c.end <= from + 1e-6) continue;
        if (to > from && c.start >= to - 1e-6) continue;
        return true;
    }
    return false;
}

/// The track as a file, on the output's clock.
///
/// `from`/`to` are the render's range in timeline seconds. Everything outside it
/// is dropped and a cue straddling the start is clamped to zero, which is the one
/// place either can happen: the row's window is left at zero precisely so that
/// this is the only shift, and a `-ss` in front of the `-i` would apply a second.
///
/// Returns '' where the track has nothing in the range, which the caller reads as
/// "write no file and map no stream" — an empty subtitle file is a stream the
/// muxer writes a header for and no cues into, which looks in a player exactly
/// like a track that failed.
export function cueFileText(track, from, to) {
    const kept = [];
    for (const c of track.cues) {
        if (c.end <= from + 1e-6) continue;
        if (to > from && c.start >= to - 1e-6) continue;
        kept.push({
            start: Math.max(0, c.start - from),
            end: Math.max(0, (to > from ? Math.min(c.end, to) : c.end) - from),
            text: c.text,
            raw: c.raw,
        });
    }
    if (!kept.length) return '';
    return track.header ? assText(track, kept) : srtText(kept);
}

/// `H:MM:SS.cc`, which is what an ASS `Start`/`End` field is. Centiseconds, so a
/// cue dragged to a frame boundary at 25 fps lands on one exactly.
function assTime(t) {
    const cs = Math.max(0, Math.round(t * 100));
    const h = Math.floor(cs / 360000);
    const m = Math.floor(cs / 6000) % 60;
    const s = Math.floor(cs / 100) % 60;
    return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

/// `HH:MM:SS,mmm`, which is what SubRip counts in — a comma, not a point, and a
/// parser that is handed a point reads the cue as untimed.
function srtTime(t) {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms % 1000).padStart(3, '0')}`;
}

const pad = (n) => String(n).padStart(2, '0');

/// The script header, then one `Dialogue:` per cue.
///
/// The header is the decoder's own, verbatim — it already ends with `[Events]`
/// and the `Format:` line the fields below are ordered by, which is why nothing
/// here writes either. A `Dialogue:` event is the decoder's line with `ReadOrder`
/// dropped and the two times put in its place, because that is exactly the
/// difference between the two shapes: `Layer,Start,End,Style,…` against
/// `ReadOrder,Layer,Style,…`.
///
/// A cue with no line of its own — one typed into a forked track — gets the
/// minimum that is still valid, `Default` and no margins, which is what the
/// header's own first style is called in every file libavcodec writes.
function assText(track, cues) {
    const head = track.header.replace(/\r?\n?$/, '\n');
    const lines = [head];
    for (const c of cues) {
        const p = c.raw ? assSplit(c.raw) : { ok: false };
        if (p.ok && !p.prefix && p.heads.length === MODERN) {
            const [, layer, style, name, ml, mr, mv, effect] = p.heads;
            lines.push(`Dialogue: ${layer},${assTime(c.start)},${assTime(c.end)},` +
                       `${style},${name},${ml},${mr},${mv},${effect},${p.text}\n`);
        } else if (p.ok && p.prefix && p.heads.length === LEGACY) {
            // The older shape is already an event: only its two times move.
            const h = p.heads.slice();
            h[1] = assTime(c.start);
            h[2] = assTime(c.end);
            lines.push(`Dialogue:${h.join(',')},${p.text}\n`);
        } else {
            lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},` +
                       `Default,,0,0,0,,${assEscape(c.text)}\n`);
        }
    }
    return lines.join('');
}

/// SubRip: a number, a time range, the lines, a blank line. The number counts
/// from one and is the cue's position rather than anything stored — SubRip's
/// index is decoration, and a list that skipped 4 because a cue was deleted would
/// be a file some parsers stop reading at.
function srtText(cues) {
    let out = '';
    cues.forEach((c, i) => {
        out += `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n` +
               `${String(c.text || '').replace(/\r\n?/g, '\n')}\n\n`;
    });
    return out;
}

/// Where this track's file goes for a render aimed at `path`.
///
/// **Beside the output, named from it and from the track's id.** The id is what
/// makes the name stable across renders, so rendering twice overwrites one file
/// rather than leaving a trail; the output's stem is what makes two edits in one
/// directory not collide. A destination with a scheme on it, or a `tee` list, has
/// no directory to sit beside — those go to the temp directory, which is still a
/// real file the printed command can read.
export function cueFilePath(track, path) {
    const ext = fileExtension(track);
    const p = String(path || '');
    const local = p && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p) && p.indexOf('|') < 0;
    if (!local) return bro.ffmpeg.tempPath(`sub${track.id}.${ext}`);
    return `${p.replace(/\.[^./\\]*$/, '')}.sub${track.id}.${ext}`;
}

/// Write it. Returns the path, or '' where there was nothing in range to write.
///
/// **Called when a render starts and at no other moment.** `buildSpec()` runs on
/// every keystroke of every field on the Encode and Write stages — five times per
/// redraw before the memo — and a file written from there would be a disk write
/// per character typed into the output path. So the spec *names* the file, which
/// is what the command bar prints and what `render.start` opens, and `ui/export.js`
/// puts the bytes there on the way past. The window between the two is the same
/// window every render already has: nothing else can be writing that name, because
/// the name has this track's id in it.
export function writeCueFile(track, path, from, to) {
    const text = cueFileText(track, from, to);
    if (!text) return '';
    fs.writeFileSync(String(path), text, 'utf-8');
    return String(path);
}

// ── the document ───────────────────────────────────────────────────────────

/// Every cue track, as the document holds it.
///
/// `raw` travels with `text`, which looks like storing the same fact twice and is
/// not: one is what the cue says and the other is how it looks, and a document
/// that dropped the second would silently flatten a styled track the first time
/// it was saved and reopened — which is exactly the failure this module exists
/// against, arriving by the back door.
export function cueBlob() {
    return cueTracks.map((t) => ({
        id: t.id,
        name: t.name,
        from: t.from,
        header: t.header,
        cues: t.cues.map((c) => ({ start: c.start, end: c.end, text: c.text, raw: c.raw })),
    }));
}

/// And back again — version-tolerant, like every other reader here.
///
/// A **replacement**: what comes out is what the document says and nothing else,
/// because an open is a replacement of the edit. Ids are carried through and told
/// to the counter, for the reason at the top; a document naming the same id twice
/// gets a fresh one for the second, whose stream row then simply does not apply —
/// the same answer `ui/document.js` gives a repeated clip id.
export function adoptCues(saved) {
    clearCueTracks();
    const seen = new Set();
    for (const t of Array.isArray(saved) ? saved : []) {
        if (!t || typeof t !== 'object') continue;
        const track = makeCueTrack(t);
        const id = Math.round(Number(t.id));
        if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
            seen.add(id);
            track.id = id;
            useCueId(id);
        }
    }
}

/// Something in a track changed, said on the model's own channel so that it is
/// one step of undo, one touch of the unsaved marker and one redraw of the lane —
/// exactly what an edit to a clip is.
///
/// **The kind matters, because `ui/history.js` folds a run of one kind into one
/// step.** That rule exists for sliders and it is exactly right for typing —
/// forty characters is one thing somebody did — and exactly wrong for the
/// presses: splitting a cue and then adding one are two acts half a second apart
/// and an undo has to answer with the one you meant. So the keystrokes are
/// `cues`, a retime is `cue-time`, and each press on the words strip passes its
/// own button's name. What is left folding is two presses of the *same* button
/// inside half a second, which is the standing trade this application makes
/// everywhere and is what the rule is for.
export function cuesChanged(what = 'cues') { changed(what); }
