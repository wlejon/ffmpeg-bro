// The corpus, as a tool drives it: the steps that need an application, and the
// question the store is asked once it is built.
//
// **The store itself is no longer here.** Where a channel's recordings live,
// what is on disk, how a recording is pulled and how a page is resolved are
// `corpus/` — a module set with no interface in it, imported by this and by the
// supercut application both. The reason is one concrete thing: `pullMedia` used
// to drive the *workbench* (`shell.goTo('write')`, a click on `#ex-go`), so a
// window that does not have a Write stage could not pull a recording, and
// "type a streamer's name and get their VODs" was therefore a command line and
// nothing else. `corpus/pull.js` is that copy with the interface taken off it.
//
// What is left here is what genuinely needs an application to be driven:
//
//   openMedia   open a path as an input and lay it out as a clip
//   clearEdit   put the application back to an empty edit
//
// and the reading half that has no reason to move — `search`, `streamFor`,
// `twitchTime` — which answers questions off the transcripts on disk.
//
// **`transcribeVod` was the third and is `corpus/words.js` now.** It was here
// because it drove the Write stage: it rendered five-minute wavs of the
// recording and handed each to a synchronous `bro.stt` call, which is a command
// line and could never have been anything else. `bro.ffmpeg.words` reads a
// soundtrack on a thread, so the whole step became a job a frame loop can poll,
// and it moved for `pullMedia`'s reason exactly — a window that can search six
// hours of somebody talking has to be able to make the transcript it searches.
//
// See the block at the top of `corpus/store.js` for the layout, and
// `corpus/vod.js` for why page resolution is in neither application's `ui/`.

import { transcribed } from '../corpus/store.js';
import { readSrt, streamOf, find, spaced } from './transcript.js';

// The store's own calls, re-exported so that a tool importing "the corpus"
// still gets one namespace. **Re-exported and not reimplemented**: every one of
// these has exactly one home, which is `corpus/`.
export { dirFor, channelFile, vodPaths, loadState, saveState, refresh,
         loadChannel, vodsOf, transcribed, isPulled,
         probeQuietly } from '../corpus/store.js';
export { planPull, startPull, pollPull, stopPull, running } from '../corpus/pull.js';
export { startTranscribe, pollTranscribe, stopTranscribe } from '../corpus/words.js';
export { writeManifest } from '../corpus/index.js';

// ── driving the application ────────────────────────────────────────────────

/// Open a path as an input and lay it out, or throw saying why not.
///
/// **A clip, because the Write stage will not open without one.** `prepare()`
/// refuses an empty timeline, so an application holding an input and no clips
/// has no way through to the stream list — which is a real gap for exactly this
/// job, where the whole intention is "copy this input" and the timeline is
/// beside the point.
///
/// `declaredSeconds` is for an input whose container will not say how long it
/// is: `openInput` refuses to lay out a clip of no length, so a probe reporting
/// zero puts the Write stage out of reach. Writing a number onto the probe is
/// the tool supplying a total the demuxer declined to work out, from the
/// stream's own manifest — not a guess, and not a number invented here.
///
/// It was written for a Twitch HLS playlist, every rendition of which reported
/// `duration = 0` through libavformat; that is no longer what this build does —
/// see `mediaDuration` in `corpus/vod.js`, where the measurement is written
/// down — and the pull no longer goes through here at all. The parameter stays
/// because "the container will not say" is a property of containers rather
/// than of Twitch, and because it costs nothing when the probe does answer.
export function openMedia(A, drive, path, opts = {}) {
    A.shell.goTo('sources');
    drive.pump(200);
    const input = A.inputs.addInput({ path, name: opts.name || undefined,
                                      origin: opts.origin || undefined });
    drive.until(`${opts.name || path} to open`,
                () => !!input.probe || !!input.error, 300000);
    assert(!input.error, `could not open ${opts.name || path}: ${input.error}`);
    if (opts.declaredSeconds > 0 && !(input.probe.format.duration > 0))
        input.probe.format.duration = opts.declaredSeconds;
    const clip = A.openInput(input);
    assert(clip, `${opts.name || path} would not lay out as a clip ` +
                 `(length ${A.inputs.lengthOf(input)})`);
    drive.pump(400);
    return input;
}

/// Put the application back to an empty edit.
///
/// Between two VODs, because a six-hour input left on the timeline would be read
/// along with the next one — and because the decoders it holds are the memory
/// `ui/residency.js` exists not to spend.
export function clearEdit(A, drive) {
    const clips = A.project.clips.slice();
    if (clips.length) { A.selectMany(clips); A.removeSelection(); }
    // `A.inputs` is the module namespace, so the list is the exported array
    // itself — copied before the walk, because `removeInput` splices it.
    for (const input of A.inputs.inputs.slice()) A.inputs.removeInput(input);
    drive.pump(300);
}

// ── the store, asked a question ────────────────────────────────────────────

/// The searchable stream for one transcript, parsed at most once per process.
///
/// **Searching is the verb people run twenty times**, and a channel's worth of
/// transcripts is a hundred thousand cues to parse and flatten. Doing that again
/// per search is the whole cost of the search repeated for nothing — which does
/// not matter much from a command line, where starting the engine dominates, and
/// matters entirely to a UI holding one process open while somebody types.
const streams = new Map();
export function streamFor(srt) {
    let s = streams.get(srt);
    if (!s) { s = streamOf(readSrt(srt)); streams.set(srt, s); }
    return s;
}

/// A Twitch timestamp — `1h23m45s` — which is what a VOD's own player takes.
///
/// Printed beside every hit so a person can open the moment in a browser and
/// check it. A supercut assembled from times nobody verified is a supercut
/// nobody can defend, and this is the cheapest possible way to verify one.
export function twitchTime(t) {
    const s = Math.max(0, Math.floor(t));
    return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m${s % 60}s`;
}

/// Every place a phrase is said, across every transcript in the store.
///
/// Answers hits carrying the recording they came from and the local file it was
/// read out of, so a caller can go and cut the picture without asking the store
/// a second question — and the time it carries is on that file's own clock.
///
/// **Hits closer together than `spacing` collapse to the first of them.** A
/// phrase repeated for emphasis — said three times in two seconds — is one
/// moment, and three frames of it would be three near-identical pictures in a
/// flipbook whose whole content is that each frame is a different instance.
export function search(login, phrase, opts = {}) {
    const spacing = opts.spacing === undefined ? 2 : opts.spacing;
    const out = [];
    for (const vod of transcribed(login)) {
        const hits = find(streamFor(vod.srt), phrase, {
            loose: opts.loose, context: opts.context,
        });
        // The same rule the Find panel applies, and shared for the reason the
        // matching is: the two must not come to disagree about what counts as
        // one instance. They did — see `spaced` in /app/phrase.js.
        for (const h of spaced(hits, spacing)) {
            out.push({
                ...h,
                vodId: vod.id, page: vod.page, title: vod.title,
                publishedAt: vod.publishedAt,
                media: vod.media, hasMedia: vod.hasMedia,
                url: `${vod.page}?t=${twitchTime(h.at)}`,
            });
        }
    }
    return out;
}
