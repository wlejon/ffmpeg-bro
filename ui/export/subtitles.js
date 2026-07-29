// Subtitles: where a track comes from, and what it can be written as.
//
// A subtitle stream is the one kind on the Write stage with **no composed
// source**. A picture is made — the canvas — and a soundtrack is made — the mix
// — and there is no third thing here that makes cues. So a subtitle row is
// always reading something that already exists, and there are exactly two ways
// to read it:
//
//   - **Carried** (`copy:0:2`). The packets that are already there, into the new
//     container unchanged. Instant, lossless, and only possible where the
//     container will hold the codec that is in the input.
//   - **Converted** (`decode:1:0`). Decoded and written again in whatever the
//     output container holds — an `.srt` becoming `mov_text` in an mp4, `ass` in
//     a Matroska file, `webvtt` in a `.vtt` beside the video. This is `-c:s
//     mov_text` against `-c:s copy`, and it is the same `-map` either way.
//
// The third thing people mean by "subtitles" is **burning them into the
// picture**, which is not a stream at all: it is `subtitles=` on the Graph
// stage, an ordinary filter node like every other. It lives there rather than
// here on purpose — a burned-in subtitle is part of the picture, and a Write
// stage that offered it would be claiming a decision it does not own.
//
// That third thing is also the only one the *viewer* can show, and the bottom
// of this file is what a clip needs to place one: which stream, whether the
// filter can draw it, and where in the run it goes. A clip's own track and a
// programme-wide cue file are burned in at two different points because they
// are on two different clocks — see `burnAnchor`.
//
// And under that again is **when the cues are**, which is what a row's window
// has to be read against: two numbers cut a track differently depending on
// which of the two ways above the row reads it, and until `cueWindow` there was
// nowhere that said so.
//
// What is written here rather than anywhere else is the **escaping**, because
// it is a trap with a very poor error message. A filtergraph separates a
// filter's arguments with `:` and separates filters with `,`, so a Windows path
// with a drive letter in it goes into `subtitles=` unusable: libavfilter
// complains about an option called `/media/cues` and nothing in that message
// mentions the colon.
//
// One function, and it is called at the moment a node is *made* rather than at
// the moment one is printed — `ui/sources.js` is its only importer, for the `As
// a filter` line and for `burnIn()`. That is deliberate: what is stored on the
// node is the escaped string, so the graph, the render and the command bar are
// all reading one value that was escaped once. A second call in `command.js`
// would be a second escaping, and two escapings are how a printed command comes
// to differ from the render it claims to describe.

import { inputs, asInput } from '../inputs.js';
import { muxerInfo } from './capabilities.js';

/// Every subtitle encoder this build links. Discovered rather than named — see
/// `availableSubtitleEncoders` — so a build that gains one gains it here.
export const subtitleEncoders = () => (bro.ffmpeg.subtitleEncoders || []);

/// `decode:1:0` → `{ input: 1, stream: 0 }`, or null.
export function parseDecode(source) {
    const m = /^decode:(\d+):(\d+)$/.exec(String(source || ''));
    if (!m) return null;
    return { input: Number(m[1]), stream: Number(m[2]) };
}

export function isDecode(row) {
    return !!parseDecode(row && row.source);
}

export const decodeSource = (input, stream) => `decode:${input}:${stream}`;

/// Which input stream a row reads, however it reads it. One function because
/// three things ask — the `-map`, the `-i` list and the row's own sentence —
/// and a copy and a conversion name their stream in exactly the same way.
export function readsInput(row) {
    const m = /^(?:copy|decode):(\d+):(\d+)$/.exec(String((row && row.source) || ''));
    if (!m) return null;
    return { input: Number(m[1]), stream: Number(m[2]) };
}

/// Every subtitle stream on every input, offered both ways.
///
/// Both, always, because which one is right is a question about the *output*
/// container and not about the input: the same `.ass` track is a copy into
/// Matroska and a conversion into mp4, and hiding the one that will not work
/// would hide the reason it will not.
export function subtitleChoices() {
    const out = [];
    inputs.forEach((input, i) => {
        if (!input.probe) return;
        for (const s of input.probe.streams) {
            if (s.kind !== 'subtitle') continue;
            const what = `${input.name} · ${s.index}: ${s.codec}` +
                         (s.language ? ` (${s.language})` : '');
            out.push({ id: `copy:${i}:${s.index}`, label: `carry — ${what}`,
                       codec: s.codec, input: i, stream: s.index, copy: true });
            out.push({ id: decodeSource(i, s.index), label: `convert — ${what}`,
                       codec: s.codec, input: i, stream: s.index, copy: false });
        }
    });
    return out;
}

/// Which of the two ways a new row should read the first track there is.
///
/// **Carry it if the container already holds that codec, convert it otherwise**
/// — which is the same question `avformat_query_codec` answers and not a
/// preference. An `.ass` track going into Matroska is packets and costs
/// nothing; the same track going into an mp4 has to become `mov_text` or the
/// render stops at `write_header`. Defaulting to either one unconditionally
/// means half the rows arrive wrong, and a row that arrives wrong in a way that
/// still renders — a needless re-encode — is the half nobody notices.
export function defaultSubtitleSource(container) {
    const all = subtitleChoices();
    if (!all.length) return '';
    const holds = subtitleCodecsOf(container);
    const first = all[0];
    const carried = holds.some((c) => c === first.codec);
    const want = all.find((c) => c.input === first.input && c.stream === first.stream &&
                                 c.copy === carried);
    return (want || first).id;
}

/// What `probe()` said about the stream a row reads, or null.
export function readStream(row) {
    const at = readsInput(row);
    if (!at) return null;
    const input = inputs[at.input];
    if (!input || !input.probe) return null;
    return input.probe.streams.find((s) => s.index === at.stream) || null;
}

export function readInput(row) {
    const at = readsInput(row);
    return at ? inputs[at.input] || null : null;
}

/// The subtitle codecs the chosen container will hold, and the one it writes by
/// itself. Both come from `avformat_query_codec` rather than from anything
/// written down: mp4 holds one, Matroska holds several, and a hundred and fifty
/// muxers hold none — which is a fact worth being able to say out loud on a
/// stage that offers a "+ Subtitle" button.
export function subtitleCodecsOf(container) {
    const m = muxerInfo(container);
    return (m && m.subtitleCodecs) || [];
}

export function defaultSubtitleCodec(container) {
    const m = muxerInfo(container);
    return (m && m.subtitleCodec) || '';
}

export const holdsSubtitles = (container) => subtitleCodecsOf(container).length > 0;

// ── burning one into the picture ───────────────────────────────────────────

/// A path as a filter argument has to be written.
///
/// **The colon is the trap.** libavfilter splits a filter's arguments on `:`
/// and its filters on `,`, and reads `\` as an escape — so `C:/media/cues.srt`
/// arrives as a filter called `subtitles` with an option `C` and an option
/// `/media/cues.srt`, and the error says *Option not found* about something
/// that looks like half a path. Quoted as well as escaped, because a filename
/// is free to contain a comma and a comma ends the filter.
///
/// The same rule the Sources stage records for `movie=`. It is written once
/// here and used at the moment a node is *made* — the Sources panel's `As a
/// filter` line and `burnIn()` — so what the graph draws and what the command
/// bar prints are the one stored string, escaped once, rather than two
/// escapings that could differ.
///
/// The separators are taken out first, which is what makes the backslash arm
/// below unnecessary: libavfilter reads a path with forward slashes on Windows
/// and a backslash inside a filter argument is an escape character, so turning
/// them round is not a convenience — it removes the only thing in a Windows
/// path that would otherwise have to be escaped twice over. `ui/sources.js`
/// reads the result back with `unescapePath`, which is why the two have to
/// agree about the quotes as well as about the colons.
export function filterPath(path) {
    let out = '';
    for (const ch of String(path || '').replace(/\\/g, '/')) {
        if (ch === ':' || ch === '\'') out += '\\';
        out += ch;
    }
    return `'${out}'`;
}

/// Whether `subtitles=` can draw this track at all.
///
/// libavfilter's subtitles filter **is libass**: it decodes the track and
/// expects characters, and a `dvdsub` or `hdmv_pgs_subtitle` track is pictures
/// of characters. It refuses one by name rather than drawing nothing, and the
/// probe carries `textSub` — libavcodec's own `AV_CODEC_PROP_TEXT_SUB` — so the
/// control can say so before anything opens. The same fact decides whether the
/// track can be *written* as text, and for the same reason.
export const canBurn = (stream) => !!(stream && stream.kind === 'subtitle' && stream.textSub);

/// Which subtitle stream of a file `si=` means.
///
/// **It counts subtitle streams, not streams.** The second subtitle track of a
/// file whose streams are video, audio, subtitle, subtitle is `si=1` and its
/// stream index is 3, and handing the filter the stream index draws the wrong
/// language or nothing at all. Nothing about the number says which it is, which
/// is exactly the sort of thing to work out once.
export function subtitleOrdinal(probe, index) {
    let n = 0;
    for (const s of (probe && probe.streams) || []) {
        if (s.kind !== 'subtitle') continue;
        if (s.index === index) return n;
        n++;
    }
    return -1;
}

/// The `subtitles` node that burns `path`'s `ordinal`-th subtitle track in.
///
/// `si` is written only where it is not the default, so what the command bar
/// prints for the ordinary case — a file with one subtitle track, or a `.srt`
/// beside the video — is what a person would have typed.
export function burnParams(path, ordinal = 0) {
    const params = { filename: filterPath(path) };
    if (ordinal > 0) params.si = String(ordinal);
    return params;
}

/// Where a clip's own subtitles go on the graph, and it is not a free choice.
///
/// **After the decode, because that is the clock the cues are on.** A track
/// inside a file, and a `.srt` written for that file, are both timed against
/// *the file* — and the derivation's `setpts` is what turns the file's clock
/// into the edit's, so anything above it sees the timestamps the cues were
/// written against and anything below it sees the moment the clip was dragged
/// to. Burning in after the scale would move every cue by wherever the clip
/// happens to sit on the timeline.
///
/// It is also the picture's own size and its own pixel format, so the text is
/// drawn once and scaled with the shot it belongs to rather than at output size
/// over a clip that may be a quarter of the frame.
///
/// A file of cues written against the *finished programme* is the other case
/// and it has the other home: `COMPOSITE_POINT`, over the whole canvas, which
/// is what `ui/sources.js` places.
///
/// The one place this point is awkward is an input told to keep its pictures on
/// the graphics card: `after-decode` is above the derivation's `hwdownload`,
/// because that is what "after the decode" means, so a burn-in there is handed
/// a frame libass cannot draw on. Nothing here guards it, because the two
/// things that would notice already say so in their own words — the render with
/// libavfilter's message, and the settle with "these filters leave the picture
/// on the graphics card", which the clip wears as its `fx` badge.
export const burnAnchor = (clipId) => `clip:${clipId}/after-decode`;

// ── where the cues are ─────────────────────────────────────────────────────
//
// A subtitle row's window is two numbers typed into two fields, and until this
// existed nothing said what those two numbers *did*. A copied picture has the
// keyframe strip for exactly that question; a track of cues had a sentence
// saying there was nothing to snap to, which turned out to be true of one of
// the two ways a row reads a track and false of the other.
//
// **The two ways cut differently, out of the same two numbers.**
//
//   - A **conversion** decodes and writes again, and keeps a cue when the cue
//     *starts* inside the window. The output's zero is the in-point exactly, so
//     a cue that was on screen at the in-point but began before it is dropped.
//   - A **copy** is packets, and packets are taken from a backward seek: the
//     reading begins at the cue at or before the in-point — on screen at that
//     moment or long finished — and *that cue's* stamp becomes the output's
//     zero. Which is the keyframe story in subtitle vocabulary, and the reason
//     this file stopped saying a copy can begin anywhere.
//
// Both were established by rendering rather than by reading the renderer: see
// the copied-subtitle-window checks in `tests/export_test.cpp`.

const cueCache = new Map();

/// Where the cues of the track a row reads are, or null.
///
/// `bro.ffmpeg.cueTimes` reads packets and never opens a decoder, so this
/// answers for a `dvdsub` track as readily as for an `.srt` — when a picture of
/// text is on screen being the one thing anybody can say about it.
///
/// Cached against the input's opening key and the stream, like the keyframes
/// and for the same reason: the stream list is rebuilt on every keystroke in a
/// language field, and this one costs a read of the file.
///
/// `max` is 500 rather than the native default's 4000. A list this long is
/// already past what the panel shows, `complete` says when it was cut short,
/// and the cost of asking for more is a longer read of a file for cues nothing
/// would draw.
export function cuesFor(row) {
    const at = readsInput(row);
    if (!at) return null;
    const input = inputs[at.input];
    if (!input || !input.path) return null;
    const key = `${input.key}#${at.stream}`;
    if (!cueCache.has(key)) {
        try {
            cueCache.set(key, bro.ffmpeg.cueTimes(asInput(input),
                                                  { stream: at.stream, max: 500 }));
        } catch (e) {
            cueCache.set(key, null);
        }
    }
    return cueCache.get(key);
}

/// The cue a copy starting at `t` would begin on: the last one at or before it.
///
/// At or *before*, and never mind whether it is still on screen — the seek is
/// backward and takes whole packets, so a window opening in the silence after a
/// cue still carries that cue. Null when nothing starts before `t`, which is a
/// different answer from the first cue and must stay one.
export function cueAtOrBefore(list, t) {
    if (!list || !list.cues || !list.cues.length) return null;
    let best = null;
    for (const c of list.cues) {
        if (c.start <= t + 1e-6) best = c;
        else break;
    }
    return best;
}

/// What a row's window does to the track it reads.
///
/// One function because three things ask — the list's marks, the sentence under
/// it and the button that fixes it — and the rule differs between a copy and a
/// conversion in a way that must not be stated twice.
///
/// `zero` is where the output's clock starts, which is the number a person is
/// really asking about: a cue at 4 s in a window opening at 4.5 s comes out at
/// 0 through a copy and does not come out at all through a conversion.
export function cueWindow(row, list) {
    const from = Math.max(0, Number(row.copyFrom) || 0);
    const to = Number(row.copyTo) || 0;
    const converting = isDecode(row);
    const cues = (list && list.cues) || [];
    const head = converting ? null : cueAtOrBefore(list, from);
    // The cue the window opens in the middle of, if there is one: it began
    // before the in-point and had not finished at it. A copy carries it, a
    // conversion loses it, and it is the only cue either of them argues about.
    const onScreen = cues.find((c) => c.start < from - 1e-6 && c.end > from + 1e-6) || null;
    // Nothing before the in-point means nothing to begin on, and then the copy
    // begins where it was asked to — which is the renderer's rule as well as
    // this one: the packet moves the zero earlier and never later.
    const zero = converting ? from : (head ? head.start : from);
    const kept = cues.filter((c) => c.start >= zero - 1e-6 &&
                                    (to <= 0 || c.start <= to + 1e-6));
    return { from, to, converting, cues, kept, zero, head, onScreen,
             slip: converting ? 0 : from - zero };
}

/// What the window costs, as a sentence, or '' when it costs nothing.
///
/// The same job `inPointNote` does for a copied picture, and the same rule: the
/// unacceptable version is not the one that starts somewhere unexpected, it is
/// the one where nobody was told.
export function cueWindowNote(row, list) {
    if (!list || !list.cues.length) return '';
    const w = cueWindow(row, list);
    const s = (t) => `${t.toFixed(2)} s`;
    if (w.converting) {
        if (!w.onScreen)
            return `every cue that starts at or after ${s(w.from)} is written, from ` +
                   `${s(w.from)} as the output’s zero`;
        return `the cue running ${s(w.onScreen.start)} → ${s(w.onScreen.end)} is on screen ` +
               `at ${s(w.from)} but starts before it, so a conversion drops it — a cue is ` +
               `kept by where it begins. The output’s zero is ${s(w.from)} exactly.`;
    }
    if (!w.head)
        return `nothing in the track starts before ${s(w.from)}, so the copy begins there ` +
               `and ${s(w.from)} is the output’s zero`;
    if (w.slip < 0.001)
        return `${s(w.from)} is a cue, so the copy starts exactly there`;
    const why = w.onScreen ? 'is on screen there'
                           : 'had already finished, and a copy takes whole packets from a ' +
                             'backward seek';
    return `the cue at ${s(w.zero)} ${why}, so a copy asked for ${s(w.from)} begins on it — ` +
           `and that cue, not ${s(w.from)}, is where the output’s clock starts`;
}

// There was an `isSubtitlePath(path)` here, over a list of extensions built by
// asking libavformat which muxers declare a subtitle codec and neither a video
// nor an audio one — so mp4 and Matroska were correctly not in it, because
// dropping one of those is dropping a video. Nothing ever called it, and the
// reason is worth keeping: `inputs.js`'s `kindOf()` answers the same question
// from the *probe*, and an input whose every stream is subtitles is a subtitle
// file whatever it happens to be called. Asking the file beats asking its name
// wherever there is a file to ask.
