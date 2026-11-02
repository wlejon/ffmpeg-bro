// Whisper Find / Transcript controls (`bro.ffmpeg.transcript` / `bro.ffmpeg.transcribe`)
// for the Graph stage node inspector (`ui/graph/panel.js`).
//
// Surfaces speech transcription and phrase search on input/source nodes and in
// the Graph summary panel so users can run `bro.ffmpeg.transcript` directly
// from the node editor.

import { el, div, span, put, head, row } from '../dom.js';
import { clock, basename } from '../format.js';
import { inputs as documentInputs } from '../inputs.js';
import { project, timelineTime } from '../project.js';
import { setPlayhead } from '../transport.js';
import * as transcriptModel from '../transcript.js';

let phraseQuery = '';

function modelName() {
    const p = transcriptModel.modelPath();
    if (!p) return '';
    return basename(String(p).replace(/[\\/]+$/, '')) || p;
}

function ensureGraphModel() {
    if (transcriptModel.modelPath()) return true;
    if (typeof showOpenFolderDialog !== 'function') return false;
    const picked = showOpenFolderDialog(null);
    const dir = picked && picked.length ? String(picked[0]) : '';
    if (!dir) return false;
    transcriptModel.useModel(dir);
    return true;
}

function modelPickButton(redraw) {
    return el('button', {
        cls: 'tiny', 'data-f': 'grmodelpick', text: 'Model…',
        title: 'Choose the Whisper model directory (config.json, model.safetensors, vocab.json, merges.txt).',
        on: { click: () => {
            if (typeof showOpenFolderDialog !== 'function') return;
            const picked = showOpenFolderDialog(transcriptModel.modelPath() || null);
            const dir = picked && picked.length ? String(picked[0]) : '';
            if (!dir) return;
            transcriptModel.useModel(dir);
            redraw();
        } },
    });
}

function resolveNodeInput(node) {
    if (!node || node.kind !== 'input') return null;
    if (node.inputId) {
        const byId = documentInputs.find((i) => i.id === node.inputId);
        if (byId) return byId;
    }
    if (node.clip && node.clip.input) return node.clip.input;
    if (node.path) {
        const byPath = documentInputs.find((i) => i.path === node.path || i.name === node.path);
        if (byPath) return byPath;
    }
    if (Number.isInteger(node.index) && documentInputs[node.index]) {
        return documentInputs[node.index];
    }
    return null;
}

export function inputTranscriptRows(node, redraw) {
    const input = resolveNodeInput(node);
    if (!input || !transcriptModel.worthReading(input)) return [];
    return [
        head('Find / Transcript'),
        ...transcriptControlsForInput(input, redraw),
    ];
}

export function summaryTranscriptRows(redraw) {
    const soundInputs = documentInputs.filter((i) => transcriptModel.worthReading(i));
    if (!soundInputs.length) return [];
    const out = [head('Find / Transcript')];
    for (const input of soundInputs) {
        out.push(div('gp-desc mono', input.name));
        out.push(...transcriptControlsForInput(input, redraw));
    }
    return out;
}

function transcriptControlsForInput(input, redraw) {
    const e = transcriptModel.readOf(input.id);
    const model = modelName();
    const out = [];

    if (!e) {
        out.push(div('gp-desc dim',
            model ? `${model} · nothing has read this for words yet`
                  : 'no model chosen — nothing has read this for words'));
        out.push(div('gp-actions', [
            el('button', {
                cls: 'tiny primary', 'data-f': 'grtranscribe', text: 'Transcribe',
                title: 'Run bro.ffmpeg.transcript on this input\'s soundtrack.',
                on: { click: () => {
                    if (ensureGraphModel()) transcriptModel.transcribe(input);
                    redraw();
                } },
            }),
            modelPickButton(redraw),
        ]));
        return out;
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
        out.push(div('gp-desc dim', bits.join(' · ')));
        const slow = transcriptModel.whySlow();
        if (slow) out.push(div('gp-desc dim', slow));
        out.push(div('gp-actions', [
            el('button', {
                cls: 'tiny', 'data-f': 'grtranscribestop', text: 'Stop',
                on: { click: () => { transcriptModel.stopTranscribing(input.id); redraw(); } },
            }),
        ]));
        if (r && r.segments && r.segments.length) {
            out.push(...searchBoxRows(input, r));
        }
        return out;
    }

    if (e.state === 'failed') {
        out.push(div('gp-problems', div('gp-problem', e.error || 'will not read')));
        out.push(div('gp-actions', [
            el('button', {
                cls: 'tiny', 'data-f': 'grtranscribe', text: 'Again',
                on: { click: () => {
                    if (!ensureGraphModel()) return redraw();
                    transcriptModel.dropTranscript(input.id);
                    transcriptModel.transcribe(input);
                    redraw();
                } },
            }),
            modelPickButton(redraw),
        ]));
        return out;
    }

    const r = e.result || { segments: [], read: 0, duration: 0 };
    const part = e.state === 'stopped' || (r.duration > 0 && r.read < r.duration - 0.5);
    out.push(div('gp-desc dim',
        `${r.segments.length} segment${r.segments.length === 1 ? '' : 's'}` +
        (part ? ` · first ${clock(r.read)} of ${clock(r.duration)}` : ' · all of it')));
    out.push(div('gp-actions', [
        part ? el('button', {
            cls: 'tiny', 'data-f': 'grtranscribe', text: 'Start over',
            on: { click: () => {
                if (!ensureGraphModel()) return redraw();
                transcriptModel.dropTranscript(input.id);
                transcriptModel.transcribe(input);
                redraw();
            } },
        }) : null,
        el('button', {
            cls: 'tiny', 'data-f': 'grtranscribeforget', text: 'Forget',
            on: { click: () => { transcriptModel.dropTranscript(input.id); redraw(); } },
        }),
        modelPickButton(redraw),
    ].filter(Boolean)));

    if (r.segments && r.segments.length) {
        out.push(...searchBoxRows(input, r));
    }
    return out;
}

function searchBoxRows(input, r) {
    const list = div('gp-filter-list');
    const renderHits = () => put(list, () => {
        const q = phraseQuery.trim();
        const hits = q
            ? transcriptModel.searchIn(input.id, q)
            : r.segments.slice(0, 12).map((s) => ({
                  inputId: input.id, start: s.start, end: s.end, text: s.text, at: 0,
              }));
        if (!hits.length) return [div('gp-desc dim', 'no matching spoken segments')];
        return hits.slice(0, 20).map((hit) => el('button', {
            cls: 'gp-filter', 'data-hit-start': String(hit.start),
            title: 'Jump playhead to this spoken segment',
            on: { click: () => {
                const rows = transcriptModel.hitRows(hit, project.clips);
                const target = rows.length ? rows[0].t : hit.start;
                setPlayhead(Math.max(0, target));
            } },
        }, [
            span(clock(hit.start), 'gp-badge mono'),
            span(hit.text, 'dim'),
        ]));
    });

    const field = el('input', {
        cls: 'wide', 'data-f': 'grfindphrase', type: 'text', value: phraseQuery,
        placeholder: 'search spoken words…',
        on: { input: () => { phraseQuery = field.value; renderHits(); } },
    });
    renderHits();
    return [row('Find words', field), list];
}
