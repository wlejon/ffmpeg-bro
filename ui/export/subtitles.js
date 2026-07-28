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

import { inputs } from '../inputs.js';
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

// There was an `isSubtitlePath(path)` here, over a list of extensions built by
// asking libavformat which muxers declare a subtitle codec and neither a video
// nor an audio one — so mp4 and Matroska were correctly not in it, because
// dropping one of those is dropping a video. Nothing ever called it, and the
// reason is worth keeping: `inputs.js`'s `kindOf()` answers the same question
// from the *probe*, and an input whose every stream is subtitles is a subtitle
// file whatever it happens to be called. Asking the file beats asking its name
// wherever there is a file to ask.
