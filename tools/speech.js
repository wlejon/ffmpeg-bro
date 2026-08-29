// Getting words with times out of something a tool is holding, and the one
// place that knows how.
//
// Shared by `transcribe.js`, which writes a whole file's words out as cues, and
// by `montage.js`, which transcribes a few seconds to work out whether the cues
// it was handed describe the file it is cutting.
//
// ── What left this file, and why the loop had to be one of them ───────────
//
// This used to hold the whole recipe: a wav reader, the Parakeet loader, the
// prefix-by-prefix detokenization that turns a token run into words, and
// `transcribeSpan` — the decode-then-listen loop, with the three measured window
// lengths written down beside it. All of that is `bro.ffmpeg.words` now
// (`src/native/spoken_words.h`), and the move was forced rather than tidy.
//
// **The framing recipe cannot have two homes.** `DEFAULTS.windowSeconds` and
// `DEFAULTS.overlapSeconds` here and `kWordsWindowSec`/`kWordsOverlapSec` there
// are the same fact — how a long recording is divided before the model hears it
// — and every word in every transcript this repository writes depends on the two
// agreeing. Two copies of a number that decides that is the arrangement where a
// change to one moves half a corpus quietly and nothing anywhere says so.
//
// The native one is the home: its comments carry the measurements that chose the
// numbers, and `tests/words_test.cpp` asserts them, so a change to the recipe
// fails a suite loudly. Restating them here as "the measured defaults" — the
// obvious smaller fix — would have left the words this file produces and the
// words the corpus is written with free to disagree while both cited the same
// measurement. So the loop went with them.
//
// **Montage could follow, which is what made this the clean answer rather than
// the convenient one.** The question was whether what `montage.js` needs is a
// *file*, since `bro.ffmpeg.words.reads.start` takes a path or an input and
// nothing else. It is: both of its speech calls already render a span of the
// timeline to a wav on disk and then read that wav back, so the render stays and
// what happens to the wav afterwards is a native read instead of a JS loop over
// a Float32Array. Two things came free with it — the span is now windowed at
// 15 s rather than handed over whole at 30 s, which the measurements in
// `spoken_words.h` say is both faster and *more accurate*, and the words
// `measureShift` compares against the corpus are now produced by exactly the
// code the corpus was produced by, which is the comparison it was always meant
// to be making.
//
// What is left here is the two things that are genuinely a tool's: rendering a
// span of an application's timeline, and measuring one clock against another.

import { bare } from '/app/phrase.js';
import { startRead, pollRead, reading } from '../corpus/words.js';

/// Compared with the punctuation and the case taken out, because a transcript
/// writes "you," and "Thank" and a search means both.
///
/// Re-exported rather than defined: the flattening rule is one of the facts the
/// application's Find panel and these tools have to agree on exactly, so it
/// lives in `/app/phrase.js` with the search it belongs to.
export { bare };

// ── the words in a file, waited for ────────────────────────────────────────

/// A whole soundtrack read to words, blocking, on **this** driver's terms.
///
/// `bro.ffmpeg.words` never blocks and `corpus/words.js` wraps it in a job a
/// frame loop can poll. A command line wants the opposite — the answer, now —
/// so this is the one place that stands on the JS thread and pumps until the
/// read lands. It is a *tool's* half deliberately: nothing in `corpus/` may
/// stop the world, because a window imports it.
///
/// `source` is a path or an input spec. `base` is added to every time, for a
/// caller that rendered a span out of something longer and wants the answer on
/// the original's clock. `opts` is `corpus/words.js`'s (`model`, `device`,
/// `duration`) plus `onProgress(job)`, called about once a second — a five-hour
/// recording is half an hour of work and a tool that said nothing until the end
/// would be indistinguishable from one that had hung.
///
/// The wait is bounded well past the native reader's own twelve-hour timeout, so
/// what ends a runaway read is the reader failing by name rather than this
/// giving up on a run that is still working.
export function heardIn(drive, source, base = 0, opts = {}) {
    const job = startRead(source, opts);
    drive.until(`the words in ${source}`, () => !reading(pollRead(job)),
                opts.timeoutMs || 13 * 60 * 60 * 1000,
                opts.onProgress ? () => opts.onProgress(job) : null);
    assert(job.state !== 'failed', `reading the words: ${job.error}`);
    return base ? job.result.map((w) => ({ from: w.from + base,
                                           to: w.to + base, text: w.text }))
                : job.result;
}

// ── rendering a span of a timeline to something that can be read ───────────

/// Render one span of whatever is on the timeline to a 16 kHz mono wav.
///
/// An ordinary render with an ordinary encoder — the point being that the ASR
/// gets its samples through the same path everything else here gets its output,
/// so a file this application can play is a file it can transcribe. Answers the
/// path, which is what `heardIn` takes.
///
/// **Arrive first, then set.** Entering the stage runs `prepare()`, which runs
/// `clampToEncoder()` — so settings written before the move are settings the
/// stage gets a chance to pull back inside what it thinks the encoder takes.
/// Asking for 16 kHz and then walking through that door produced a 48 kHz wav.
///
/// The rate is no longer load-bearing and is still asked for. It used to be:
/// `bro.stt` refuses anything but 16 kHz and this render was the only thing
/// standing between a clamped setting and that refusal, so the loop that read
/// the wav checked what came out. The native reader puts every input through
/// `SourceAudio`, which resamples, so a wav at any rate would now be read
/// correctly — 16 kHz mono is simply the smallest file that loses nothing, at a
/// thirtieth of what 48 kHz stereo would write for the same span.
export function renderAudio(A, drive, start, end, wav) {
    A.shell.goTo('write');
    drive.pump(250);
    const S = A.exporter.currentSettings();
    S.container = 'wav';
    S.audioCodec = 'pcm_s16le';
    S.audio = true;
    S.sampleRate = 16000;
    S.channels = 1;
    S.rangeIn = start;
    S.rangeOut = end;
    S.path = wav;
    // One audio stream from the mix and nothing else: a video row here would be
    // an encode of pictures nobody is going to look at.
    S.streams = A.exporter.defaultStreams().filter((s) => s.kind === 'audio');
    A.exporter.redraw();
    drive.pump(200);
    document.getElementById('ex-go').click();
    drive.until('the audio to render',
                () => bro.ffmpeg.render.poll().state !== 'running', 30 * 60 * 1000);
    const p = bro.ffmpeg.render.poll();
    assert(p.state === 'done', `rendering the audio ${p.state}: ${p.error || ''}`);
    return wav;
}

/// A span of the timeline, transcribed — the two halves above in one call.
///
/// `montage.js` does this twice for two different questions and did it with four
/// lines each time. Answers `{ from, to, text }` words on the *timeline's* clock.
export function heardOnTimeline(A, drive, start, end, wav, opts = {}) {
    renderAudio(A, drive, start, end, wav);
    const words = heardIn(drive, wav, start, opts);
    try { require('fs').unlinkSync(wav); } catch (e) { /* gone */ }
    return words;
}

// ── whose clock a transcript is on ─────────────────────────────────────────

/// How far a transcript's clock is from this media's, in seconds, or null.
///
/// **Two renditions of one stream do not share a zero, and nothing declares it.**
/// A transcript made from the audio-only pull of a Twitch VOD described the
/// 1080p pull of the same VOD 0.80 s late — measured over sixteen consecutive
/// words, every one of them 0.78–0.80 s adrift — while both files reported the
/// same duration to the millisecond and neither carried a start time. Cutting
/// the picture at the sound's times therefore missed every word: a 2.4 s clip
/// still contained it, and a 1.2 s clip did not.
///
/// So the words this media actually says are matched against the words the
/// transcript claims, and the difference is the answer. `local` is a window
/// transcribed from the media itself; `words` is the transcript. A run of
/// `runLength` words matched in order is what counts, because short runs repeat
/// — "thank you" alone appears 27 times in five hours and would align to any of
/// them.
export function measureShift(local, words, runLength = 8) {
    const hay = words.map((w) => bare(w.text));
    const needleAll = local.map((w) => bare(w.text));
    for (let i = 0; i + runLength <= needleAll.length; i++) {
        const needle = needleAll.slice(i, i + runLength);
        let found = -1;
        let count = 0;
        for (let j = 0; j + runLength <= hay.length; j++) {
            let ok = true;
            for (let k = 0; k < runLength; k++)
                if (hay[j + k] !== needle[k]) { ok = false; break; }
            if (!ok) continue;
            found = j;
            if (++count > 1) break;     // ambiguous — try the next run along
        }
        if (count !== 1) continue;
        // The mean over the whole matched run rather than its first word, so one
        // token emitted a frame late cannot set the answer by itself.
        let sum = 0;
        for (let k = 0; k < runLength; k++)
            sum += words[found + k].from - local[i + k].from;
        return { shift: sum / runLength, at: local[i].from, words: needle.join(' ') };
    }
    return null;
}
