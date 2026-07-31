// Turning a media file into words with times, and the one place that knows how.
//
// Shared by `transcribe.js`, which writes a whole file's words out as cues, and
// by `montage.js`, which transcribes a few seconds to work out whether the cues
// it was handed describe the file it is cutting. Both need the same three awkward
// things, and none of them may be written twice: the render to what the model
// eats, the wav reader, and — the subtle one — how a token sequence becomes
// words.

const fs = require('fs');

/// A 16-bit PCM wav as the floats the model wants.
///
/// Written here rather than reached for because there is nothing to reach for:
/// the only wav reader in this repository is libavformat's, and it hands back
/// decoded frames rather than a Float32Array. The parse is the minimum — find
/// `fmt ` and `data`, and refuse anything that is not the one shape the render
/// below just asked the encoder for.
export function readWav16(path) {
    const buf = fs.readFileSync(path);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    assert(dv.getUint32(0, false) === 0x52494646, `${path} is not a RIFF file`);
    let at = 12;
    let channels = 0;
    let rate = 0;
    let bits = 0;
    while (at + 8 <= dv.byteLength) {
        const id = dv.getUint32(at, false);
        const size = dv.getUint32(at + 4, true);
        const body = at + 8;
        if (id === 0x666d7420) {            // 'fmt '
            channels = dv.getUint16(body + 2, true);
            rate = dv.getUint32(body + 4, true);
            bits = dv.getUint16(body + 14, true);
        } else if (id === 0x64617461) {     // 'data'
            assert(bits === 16, `${path} is ${bits}-bit, not 16`);
            const frames = Math.floor(size / 2 / Math.max(1, channels));
            const samples = new Float32Array(frames);
            for (let i = 0; i < frames; i++)
                samples[i] = dv.getInt16(body + i * 2 * channels, true) / 32768;
            return { samples, sampleRate: rate };
        }
        at = body + size + (size & 1);
    }
    throw new Error(`${path} has no data chunk`);
}

/// Parakeet and its tokenizer.
///
/// **The *file*, not the directory** for the tokenizer — `loadParakeet` takes the
/// weights dir and `loadParakeetTokenizer` takes `tokenizer.json` inside it,
/// which is a real asymmetry in the API and reads as a typo until it throws.
export function loadSpeech(root, opts = {}) {
    const weights = `${root}/../brosoundml/weights/parakeet/0.6b-v3`;
    const model = bro.stt.loadParakeet(weights, opts.device ? { device: opts.device } : {});
    const tok = bro.stt.loadParakeetTokenizer(`${weights}/tokenizer.json`);
    return { model, tok, frameSeconds: model.frameSeconds, sampleRate: model.sampleRate };
}

/// One window of audio as `{ from, to, text }` words, on whatever clock `base`
/// is measured on.
///
/// **A word boundary is only visible to the tokenizer, so ask it.** Parakeet's
/// vocabulary is SentencePiece, and the obvious reading — decode each id and
/// split on the leading `▁` — does not work, because decoding *one* id strips
/// the marker: `And` and `so` come back bare and are indistinguishable from
/// `coun` and `try`. The boundary survives only in the detokenization of a run,
/// where `decode([And, so])` is "And so" and `decode([coun, try])` is "country".
///
/// So the sequence is decoded prefix by prefix and each token is credited with
/// whatever it *appended*: a piece that arrives with a leading space starts a
/// word, and one that does not continues the one before it. That is the
/// tokenizer's own rule rather than a second implementation of it, which is the
/// only way this cannot drift from the model. Getting it wrong is not subtle in
/// its effect and is very subtle to see: every token joined into one "word", and
/// ten minutes of speech came out as two of them.
export function wordsOf(speech, res, base) {
    const words = [];
    const ids = Array.from(res.tokenIds);
    let sofar = '';
    let word = '';
    let wordAt = 0;
    const flush = (endsAt) => {
        if (word) words.push({ from: wordAt, to: endsAt, text: word });
        word = '';
    };
    for (let i = 0; i < ids.length; i++) {
        const grown = speech.tok.decode(ids.slice(0, i + 1), true);
        const piece = grown.slice(sofar.length);
        sofar = grown;
        if (!piece) continue;
        const t = base + res.tokenFrames[i] * speech.frameSeconds;
        if (/^\s/.test(piece) || !word) {
            flush(t);
            wordAt = t;
            word = piece.trim();
        } else {
            word += piece;
        }
    }
    flush(base + (ids.length ? res.tokenFrames[ids.length - 1] * speech.frameSeconds : 0));
    return words;
}

/// Render one span of whatever is on the timeline to a 16 kHz mono wav.
///
/// An ordinary render with an ordinary encoder — the point being that the ASR
/// gets its samples through the same path everything else here gets its output,
/// so a file this application can play is a file it can transcribe.
///
/// **Arrive first, then set.** Entering the stage runs `prepare()`, which runs
/// `clampToEncoder()` — so settings written before the move are settings the
/// stage gets a chance to pull back inside what it thinks the encoder takes.
/// Asking for 16 kHz and then walking through that door produced a 48 kHz wav
/// and a model that refused it by name, which is the refusal working and the
/// order being wrong.
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
    return readWav16(wav);
}

/// Compared with the punctuation and the case taken out, because a transcript
/// writes "you," and "Thank" and a search means both.
export const bare = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

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
