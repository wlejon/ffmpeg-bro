// Deep reads on the Sources stage (`ui/sources.js`):
//   - Sound marks (`bro.ffmpeg.marks` via `ui/marks.js`)
//   - Whisper speech transcription (`bro.ffmpeg.transcript` / `bro.ffmpeg.transcribe` via `ui/transcript.js`)
//   - GPMF / data stream telemetry (`bro.ffmpeg.data` via `ui/telemetry.js`)
//
// Extracted into a dedicated module to keep `ui/sources.js` and
// `ui/sources-detail.js` strictly under 1,000 lines.

import { el, div, span } from './dom.js';
import { clock, basename } from './format.js';
import { streamsWorthReading, readingOf, readStream, dropReading,
         isPicked, pick, labelOf } from './telemetry.js';
import * as marksModel from './marks.js';
import * as transcriptModel from './transcript.js';

const MARK_KINDS = Object.keys(marksModel.MARK_WORDS);

/// Every deep read of this input, in one section, in one vocabulary.
export function readRows(input, ctx) {
    if (!input || !input.probe) return [];
    const rows = [
        ...soundRow(input, ctx),
        ...wordsRows(input, ctx),
        ...telemetryRows(input, ctx),
    ];
    if (!rows.length) return [];
    return [
        div('src-sec-head', [
            span('Reading it', 'src-sec-title'),
            span('what takes this machine time, asked for one at a time', 'dim'),
        ]),
        div('src-reads', rows),
    ];
}

function readLine(what, of, ofWhy, said, acts) {
    return div('src-read-line', [
        span(what, 'src-read-k'),
        span(of, 'src-read-of mono', ofWhy ? { title: ofWhy } : null),
        typeof said === 'string' ? span(said, 'src-read-v dim') : said,
        div('src-read-acts', (acts || []).filter(Boolean)),
    ]);
}

function readUnder(kids) { return div('src-read-more', kids.filter(Boolean)); }

function soundStream(input, entry) {
    const p = (input.probe && input.probe.streams) || [];
    const audio = p.filter((s) => s.kind === 'audio');
    const got = entry && entry.result && entry.result.streamIndex;
    if (Number.isInteger(got) && got >= 0)
        return { of: `A${got}`, why: audio.length > 1
            ? `read from A${got} — the best of this input's ${audio.length} soundtracks`
            : 'read from this input\'s soundtrack' };
    if (audio.length === 1)
        return { of: `A${audio[0].index}`, why: 'the only soundtrack in this input' };
    return { of: `best of ${audio.length}`,
             why: `This input has ${audio.length} soundtracks and a read takes one — ` +
                  'av_find_best_stream\'s pick, which is what [0:a] means on a ' +
                  'command line. Which one it was is on this row once it has run.' };
}

function soundRow(input, ctx) {
    if (!marksModel.worthReading(input)) return [];
    const { drawSources } = ctx;

    const e = marksModel.readOf(input.id);
    const { of, why } = soundStream(input, e);

    if (!e)
        return [readLine('Sound', of, why, 'nothing has listened to this yet', [
            el('button', { cls: 'btn tiny', text: 'Find sounds',
                           title: 'Decode this soundtrack and mark where something ' +
                                  'happens in it. It reads the whole track -- about ' +
                                  'a minute per hour of sound -- on a thread, so ' +
                                  'nothing here stops while it does. Nothing is ' +
                                  'classified: a mark says when, never what.\n' +
                                  MARK_KINDS.map((k) => `${k}: ${marksModel.MARK_WORDS[k]}`)
                                            .join('\n'),
                           on: { click: () => { marksModel.findSounds(input);
                                                drawSources(); } } }),
        ])];

    if (e.state === 'reading')
        return [readLine('Sound', of, why, 'Listening' + (e.elapsed > 0.4
            ? ' · ' + e.elapsed.toFixed(1) + 's' : '') + '…', [])];

    if (e.state !== 'done')
        return [readLine('Sound', of, why,
                         span(e.error || 'will not read', 'src-read-v src-error'), [
            el('button', { cls: 'btn tiny', text: 'Again',
                           on: { click: () => { marksModel.dropMarks(input.id);
                                                marksModel.findSounds(input);
                                                drawSources(); } } }),
        ])];

    const rows = [readLine('Sound', of, why, marksModel.summaryOf(e), [
        el('button', { cls: 'btn tiny', text: 'Forget',
                       title: 'Drop these marks and take them off the timeline.',
                       on: { click: () => { marksModel.dropMarks(input.id);
                                            drawSources(); } } }),
    ])];
    const kept = countByKind(e);
    rows.push(readUnder(MARK_KINDS.map((kind) =>
        el('button', {
            cls: 'src-series' + (marksModel.isShown(kind) ? ' on' : ''),
            title: marksModel.MARK_WORDS[kind],
            on: { click: () => {
                marksModel.showKind(kind, !marksModel.isShown(kind));
                drawSources();
            } },
        }, [
            span(kind, 'mono'),
            span(String(kept[kind] || 0), 'dim'),
        ]))));
    return rows;
}

function countByKind(entry) {
    const out = {};
    const r = entry && entry.result;
    if (!r) return out;
    for (const m of r.marks) out[m.kind] = (out[m.kind] || 0) + 1;
    return out;
}

function ensureModel(ctx) {
    if (transcriptModel.modelPath()) return true;
    if (typeof showOpenFolderDialog !== 'function') return false;
    const picked = showOpenFolderDialog(null);
    const dir = picked && picked.length ? String(picked[0]) : '';
    if (!dir) {
        const hooks = typeof ctx.hooks === 'function' ? ctx.hooks() : ctx.hooks;
        if (hooks && hooks.flash)
            hooks.flash('Nothing was read: a Whisper model directory has to be ' +
                        'chosen first — brosoundml\'s scripts/download-whisper.sh ' +
                        'puts one on disk.');
        return false;
    }
    transcriptModel.useModel(dir);
    return true;
}

function modelName() {
    const p = transcriptModel.modelPath();
    if (!p) return '';
    return basename(String(p).replace(/[\\/]+$/, '')) || p;
}

function modelButton(ctx) {
    return el('button', {
        cls: 'btn tiny', 'data-f': 'srcmodelpick', text: 'Model…',
        title: 'Choose the directory the weights are in.\n' +
               'It holds config.json, model.safetensors, vocab.json and ' +
               'merges.txt.\nNothing is downloaded here: brosoundml\'s ' +
               'scripts/download-whisper.sh --size large-v3 puts one on disk.\n' +
               'tiny is 145 MB and reads clean speech; large-v3 is 3 GB and is ' +
               'the one to use if the transcript has to be right.\n' +
               'Remembered between runs — the weights are a property of the ' +
               'machine rather than of the edit, so this is the same choice for ' +
               'every input.',
        on: { click: () => {
            if (typeof showOpenFolderDialog !== 'function') return;
            const picked = showOpenFolderDialog(transcriptModel.modelPath() || null);
            const dir = picked && picked.length ? String(picked[0]) : '';
            if (!dir) return;
            transcriptModel.useModel(dir);
            ctx.drawSources();
        } },
    });
}

function wordsRows(input, ctx) {
    if (!transcriptModel.worthReading(input)) return [];
    const { drawSources } = ctx;

    const e = transcriptModel.readOf(input.id);
    const { of, why } = soundStream(input, e);
    const model = modelName();
    const line = (said, acts) => readLine('Words', of, why, said, acts);

    if (!e) {
        const start = el('button', {
            cls: 'btn tiny', text: 'Transcribe',
            title: 'Decode this soundtrack and read what was said in it, on ' +
                   'a thread. The words arrive while it reads, so it is ' +
                   'searchable long before it finishes.\n' +
                   'A transcript is a place to look, never a cut: the ' +
                   'renditions of a stream do not share a zero, so a hit ' +
                   'moves the playhead and you agree.',
            on: { click: () => { if (ensureModel(ctx)) transcriptModel.transcribe(input);
                                 drawSources(); } },
        });
        return [line(model ? `${model} · nothing has read this for words yet`
                           : 'no model chosen — nothing has read this for words',
                     [start, modelButton(ctx)])];
    }

    if (e.state === 'reading') {
        const r = e.result;
        const p = transcriptModel.progressOf(e);
        const bits = [];
        if (p.duration > 0) {
            bits.push(`${clock(p.read)} of ${clock(p.duration)}`);
            bits.push(`${Math.round((p.read / p.duration) * 100)}%`);
        } else bits.push('opening the soundtrack');
        if (r && r.segments.length) bits.push(`${r.segments.length} segments`);
        if (p.rate) bits.push(`${p.rate.toFixed(1)}× realtime`);
        if (p.left) bits.push(`about ${transcriptModel.showLeft(p.left)} left`);
        const rows = [line(bits.join(' · '), [
            el('button', { cls: 'btn tiny', text: 'Stop',
                           title: 'Stop here and keep the words already found.',
                           on: { click: () => { transcriptModel.stopTranscribing(input.id);
                                                drawSources(); } } }),
        ])];
        const slow = transcriptModel.whySlow();
        if (slow) rows.push(readUnder([span(slow, 'ex-note')]));
        return rows;
    }

    if (e.state === 'failed')
        return [line(span(e.error || 'will not read', 'src-read-v src-error'), [
            el('button', { cls: 'btn tiny', text: 'Again',
                           on: { click: () => {
                               if (!ensureModel(ctx)) return drawSources();
                               transcriptModel.dropTranscript(input.id);
                               transcriptModel.transcribe(input);
                               drawSources(); } } }),
            modelButton(ctx),
        ])];

    const r = e.result || { segments: [], read: 0, duration: 0 };
    const part = e.state === 'stopped' || (r.duration > 0 && r.read < r.duration - 0.5);
    return [line(`${r.segments.length} segment${r.segments.length === 1 ? '' : 's'}` +
                 (part ? ` · only the first ${clock(r.read)} of ${clock(r.duration)}`
                       : ' · all of it'), [
        part ? el('button', { cls: 'btn tiny', text: 'Start over',
                              title: 'Read from the beginning again.',
                              on: { click: () => {
                                  if (!ensureModel(ctx)) return drawSources();
                                  transcriptModel.dropTranscript(input.id);
                                  transcriptModel.transcribe(input);
                                  drawSources(); } } })
             : null,
        el('button', { cls: 'btn tiny', text: 'Forget',
                       title: 'Drop this transcript.',
                       on: { click: () => { transcriptModel.dropTranscript(input.id);
                                            drawSources(); } } }),
        modelButton(ctx),
    ])];
}

function telemetryRows(input, ctx) {
    const { drawSources } = ctx;
    const rows = [];
    for (const stream of streamsWorthReading(input)) {
        const of = `D${stream.index}`;
        const why = `${stream.tag || stream.codec} — parsed by the reader registered ` +
                    'for that fourcc, which is the whole identity of a data track ' +
                    '(every one of them probes as bin_data).';
        const e = readingOf(input.id, stream.index);

        if (!e) {
            rows.push(readLine('Telemetry', of, why, 'nothing has read this track yet', [
                el('button', { cls: 'btn tiny', text: 'Read it',
                               title: 'Parse this track and offer what it carries. It is a ' +
                                      'walk over the whole track -- 32 ms for a four-hour-' +
                                      'gigabyte camera file -- and it happens on a thread, ' +
                                      'so nothing here stops while it does.',
                               on: { click: () => { readStream(input, stream.index);
                                                    drawSources(); } } }),
            ]));
            continue;
        }
        if (e.state === 'reading') {
            rows.push(readLine('Telemetry', of, why, 'Reading' + (e.elapsed > 0.4
                ? ' · ' + e.elapsed.toFixed(1) + 's' : '') + '…', []));
            continue;
        }
        if (e.state !== 'done') {
            rows.push(readLine('Telemetry', of, why,
                               span(e.error || 'will not read', 'src-read-v src-error'), [
                el('button', { cls: 'btn tiny', text: 'Again',
                               on: { click: () => { dropReading(input.id, stream.index);
                                                    readStream(input, stream.index);
                                                    drawSources(); } } }),
            ]));
            continue;
        }

        const r = e.reading;
        const facts = [r.device, r.series.length + ' series', r.packets + ' packets']
            .filter(Boolean).join(' · ');
        rows.push(readLine('Telemetry', of, why, facts, [
            el('button', { cls: 'btn tiny', text: 'Forget',
                           title: 'Drop this reading and take its series off the timeline.',
                           on: { click: () => { dropReading(input.id, stream.index);
                                                drawSources(); } } }),
        ]));
        if (r.refused > 0)
            rows.push(readUnder([
                span(r.refused + ' of ' + r.packets + ' packets would not parse · ' +
                     r.refusal, 'src-error'),
            ]));
        rows.push(readUnder(r.series.map((sv) => seriesChip(input, stream.index, sv, ctx))));
    }
    return rows;
}

function seriesChip(input, streamIndex, sv, ctx) {
    const on = isPicked(input.id, streamIndex, sv);
    const reach = shortNum(sv.min) + '..' + shortNum(sv.max) + (sv.units ? ' ' + sv.units : '');
    return el('button', {
        cls: 'src-series' + (on ? ' on' : ''),
        title: labelOf(sv) + '\n' + sv.samples + ' samples at ' +
               sv.rate.toFixed(1) + ' Hz\n' + reach +
               (sv.scaled ? '' : '\nno divisor was applied to this one'),
        on: { click: () => {
            const why = pick(input.id, streamIndex, sv);
            const hooks = typeof ctx.hooks === 'function' ? ctx.hooks() : ctx.hooks;
            if (why && hooks && hooks.flash) hooks.flash(why);
            ctx.drawSources();
        } },
    }, [
        span(labelOf(sv), 'mono'),
        span(reach + (sv.scaled ? '' : ' raw'), 'dim'),
    ]);
}

function shortNum(v) {
    if (!Number.isFinite(v)) return '--';
    const a = Math.abs(v);
    if (a >= 10000) return v.toExponential(1);
    if (a >= 100) return String(Math.round(v));
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
}
