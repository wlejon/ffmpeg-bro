// Waveform painting, word/section inspector panel, cut gestures, and keyboard
// handling for the Supercut Line ruler.

import { el, div, put, setText } from '../ui/dom.js';
import { bare } from '../ui/phrase.js';
import * as library from '../ui/library.js';
import * as line from './line.js';
import * as waves from './waves.js';

const CONTEXT = 0.6;
const BAR_REACH = 8;
const TAKES_A_PAGE = 24;
const TICK_H = 9;

let rctx = null;
export function bindRulerContext(c) { rctx = c; }

function panelWindow(p, w) {
    const take0 = p.from - w.head;
    const take1 = take0 + p.natural;
    return { a: Math.max(0, Math.min(take0, p.from) - CONTEXT), b: Math.max(take1, p.until) + CONTEXT };
}

// ── the sound on the blocks ────────────────────────────────────────────────

export function paintAll() {
    const rulerNode = rctx.rulerNode();
    if (!rulerNode) return;
    for (const canvas of rulerNode.querySelectorAll('canvas.wave')) {
        const path = canvas.dataset.path;
        const from = Number(canvas.dataset.from), until = Number(canvas.dataset.until);
        const w = Math.max(4, Number(canvas.dataset.w) || 4);
        const n = Math.max(8, Math.round(w / 2));
        const wv = waves.wave(path, from, until, n);
        if (!wv || wv.error || canvas.dataset.done === 'yes') continue;
        canvas.dataset.done = 'yes';
        const h = canvas.clientHeight || 28;
        canvas.width = w; canvas.height = h;
        paintWave(canvas.getContext('2d'), wv, 0, w, h, null);
    }
    paintPanel();
}

function paintWave(ctx, wv, x, w, h, kept) {
    const n = wv.rms.length;
    const mid = h / 2;
    const half = h / 2 - 1;
    for (let i = 0; i < n; i++) {
        const px = x + (i / n) * w;
        const pw = Math.max(1, w / n);
        const inside = !kept || (px >= kept[0] && px <= kept[1]);
        const lo = Math.max(-1, wv.min[i]) * half;
        const hi = Math.min(1, wv.max[i]) * half;
        ctx.fillStyle = inside ? 'rgba(74,158,255,.40)' : 'rgba(120,130,150,.22)';
        ctx.fillRect(px, mid + lo, pw, Math.max(1, hi - lo));
        const r = Math.min(1, wv.rms[i]) * half;
        ctx.fillStyle = inside ? 'rgba(120,190,255,.85)' : 'rgba(150,160,180,.45)';
        ctx.fillRect(px, mid - r, pw, Math.max(1, r * 2));
    }
}

// ── the panel ──────────────────────────────────────────────────────────────

export function panel() {
    const n = line.count();
    const selected = rctx.selected();
    if (selected < 0 || selected >= n) return [];
    const idx = rctx.sectionIndices();
    if (idx && idx.length > 1) return sectionPanel(idx);
    const w = line.wordsOf()[selected];
    const p = line.pieceOf(selected);
    return [div('l-piece', [head(w, p), div('l-body', body(w, p))])];
}

function head(w, p) {
    const phrase = el('input', {
        type: 'text', id: 'l-phrase', value: w.phrase,
        on: {
            input: () => {
                if (!phrase.value.trim()) return;
                const selected = rctx.selected();
                line.setPhrase(selected, phrase.value);
                const box = document.getElementById('l-text');
                if (box) box.value = line.textOf();
                rctx.redrawRuler();
                const panelNode = rctx.panelNode();
                const body_ = panelNode && panelNode.querySelector('.l-body');
                if (body_) { put(body_, () => body(line.wordsOf()[selected], line.pieceOf(selected))); paintPanel(); }
                rctx.drawNote();
            },
            keydown: (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') phrase.blur(); },
        },
    });
    const bits = [];
    if (p && p.hit) {
        bits.push(`take ${p.take} of ${p.takes}`);
        bits.push(`${Math.round((p.until - p.from) * 1000)} ms`);
        if (line.onBeatOf() && p.steps) bits.push(`${p.steps} step${p.steps === 1 ? '' : 's'}`);
        const q = p.quiet || {};
        const ms = (v) => (Number.isFinite(v) ? `${Math.round(v * 1000)} ms` : '∞');
        bits.push(`quiet ${ms(q.before)} · ${ms(q.after)}`);
    }
    return div('l-line', [phrase, el('span', { cls: 'dim', text: bits.join(' · ') })]);
}

function body(w, p) {
    const i = rctx.selected();
    const rows_ = [];
    if (!p || !p.hit) {
        const why = p && p.why ? `"${w.phrase}" — ${p.why}`
                  : library.available() ? `nothing says "${w.phrase}"` : 'no corpus';
        rows_.push(div('l-line bad', [el('span', { text: why })]));
        const near = p && !p.why ? nearest(w.phrase) : [];
        if (near.length) rows_.push(div('l-line l-near', near.map((s) => el('button', {
            cls: 'tiny', text: `${s.word} ×${s.n}`,
            on: { click: () => { line.setPhrase(i, s.word); syncBox(); rctx.redraw(); } },
        }))));
        rows_.push(div('l-line', [el('span', { cls: 'spacer' }),
                                  el('button', { cls: 'tiny', text: 'Remove', on: { click: () => remove(i) } })]));
        return rows_;
    }

    const wave = el('canvas', { id: 'l-wave' });
    const win = panelWindow(p, w);
    wave.dataset.path = p.hit.vod.media;
    wave.dataset.from = String(p.from);
    wave.dataset.until = String(p.until);
    wave.dataset.a = String(win.a);
    wave.dataset.b = String(win.b);
    const barAt = (e) => {
        const r = wave.getBoundingClientRect();
        const scale = r.width / (win.b - win.a);
        const q = line.pieceOf(i) || p;
        const x0 = (q.from - win.a) * scale, x1 = (q.until - win.a) * scale;
        const x = e.clientX - r.left;
        const kind = Math.abs(x - x0) <= BAR_REACH ? 'head' : Math.abs(x - x1) <= BAR_REACH ? 'tailw' : 'slide';
        return { kind, scale };
    };
    wave.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const { kind, scale } = barAt(e);
        wave.style.cursor = kind === 'slide' ? 'grabbing' : 'ew-resize';
        cutGesture = { kind, i, x0: e.clientX, head0: w.head, tail0: w.tail, scale, moved: false };
    });
    wave.addEventListener('mousemove', (e) => {
        if (cutGesture) return;
        wave.style.cursor = barAt(e).kind === 'slide' ? 'grab' : 'ew-resize';
    });
    rows_.push(div('l-line l-wavebox', [wave]));

    if (p.takes > 1) rows_.push(takesOf(p));

    const gainVal = el('span', { cls: 'l-val mono', text: `${w.gain.toFixed(2)}×` });
    const gain = el('input', {
        type: 'range', id: 'l-gain', min: '0', max: '2', step: '0.05', value: String(w.gain),
        on: {
            input: () => { const v = line.setGain(Number(gain.value), [i]); setText(gainVal, `${v.toFixed(2)}×`); },
            change: () => rctx.hear(i),
        },
    });
    const wordLooping = rctx.isWordLooping();
    const heard = rctx.playingWord() === i && !rctx.isSaying() && !wordLooping;
    rows_.push(div('l-line', [
        el('span', { cls: 'dim', text: 'gain' }), gain, gainVal,
        el('span', { cls: 'dim', text: `· ${p.rate.toFixed(2)}×` }),
        el('span', { cls: 'spacer' }),
        el('button', {
            cls: 'tiny' + (heard ? ' on' : ''), id: 'l-hear', text: heard ? '■' : '▶',
            title: heard ? 'Stop' : 'Listen',
            on: { click: () => { if (heard) rctx.hush(); else { rctx.stopWordLoop(); rctx.hear(i); } rctx.redrawPanel(); } },
        }),
        el('button', {
            cls: 'tiny' + (wordLooping ? ' on' : ''), id: 'l-loop-word',
            text: wordLooping ? '■ loop' : '⟳ loop', title: wordLooping ? 'Stop looping' : 'Loop this word',
            on: { click: () => rctx.loopWord(i) },
        }),
        el('button', { cls: 'tiny text', text: '↺', title: 'As found', id: 'l-reset',
                       on: { click: () => { line.reset(i); rctx.redraw(); rctx.hear(i); } } }),
        el('button', { cls: 'tiny', text: 'Remove', on: { click: () => remove(i) } }),
    ]));
    return rows_;
}

function sectionPanel(idx) {
    const a = idx[0], b = idx[idx.length - 1];
    const plan = line.plan();
    let secs = 0;
    for (const p of plan.pieces) if (p.word >= a && p.word <= b) secs += p.seconds;
    const words = line.wordsOf();
    const label = `${words[a].phrase} … ${words[b].phrase}`;
    const rows_ = [];
    rows_.push(div('l-line', [
        el('span', { cls: 'l-secname', text: label }),
        el('span', { cls: 'dim', text: `${idx.length} words · ${secs.toFixed(2)} s` }),
    ]));
    const gainVal = el('span', { cls: 'l-val mono', text: `${line.gainOf(a).toFixed(2)}×` });
    const gain = el('input', {
        type: 'range', id: 'l-gain', min: '0', max: '2', step: '0.05', value: String(line.gainOf(a)),
        on: { input: () => { const v = line.setGain(Number(gain.value), idx); setText(gainVal, `${v.toFixed(2)}×`); } },
    });
    const nodes = rctx.nodes();
    rows_.push(div('l-line', [
        el('span', { cls: 'dim', text: 'gain' }), gain, gainVal,
        el('button', { cls: 'tiny', id: 'l-match', text: 'match levels', title: 'Bring these words to one level',
                       on: { click: () => { const left = line.levelMatch(idx); rctx.redraw(); if (left) setText(nodes.note, `${left} still being read`); } } }),
        el('button', { cls: 'tiny', id: 'l-reroll', text: 'other takes', title: 'The next take of each',
                       on: { click: () => { for (const i of idx) line.cycleTake(i, 1); rctx.redraw(); rctx.say(); } } }),
        el('span', { cls: 'spacer' }),
        el('button', { cls: 'tiny', text: 'Remove', on: { click: () => { for (let i = b; i >= a; i--) line.removeWord(i); rctx.clearSelectionState(); syncBox(); rctx.drawControls(); rctx.redraw(); } } }),
    ]));
    return [div('l-piece', rows_)];
}

let cutGesture = null;
document.addEventListener('mousemove', (e) => {
    if (!cutGesture) return;
    const dx = e.clientX - cutGesture.x0;
    if (!cutGesture.moved && Math.abs(dx) < 3) return;
    cutGesture.moved = true;
    const dt = dx / cutGesture.scale;
    const g = cutGesture;
    if (g.kind === 'head') line.setHead(g.i, g.head0 + dt);
    else if (g.kind === 'tailw') line.setTail(g.i, g.tail0 + dt);
    else { line.setHead(g.i, g.head0 + dt); line.setTail(g.i, g.tail0 + dt); }
    rctx.redrawRuler();
    paintPanel();
    rctx.drawNote();
});
document.addEventListener('mouseup', () => {
    if (!cutGesture) return;
    const g = cutGesture;
    cutGesture = null;
    const canvas = document.getElementById('l-wave');
    if (canvas) canvas.style.cursor = '';
    if (g.moved) { rctx.redrawPanel(); rctx.hear(g.i); }
});

export function paintPanel() {
    const canvas = document.getElementById('l-wave');
    if (!canvas) return;
    const selected = rctx.selected();
    const p = line.pieceOf(selected);
    if (!p || !p.hit) return;
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 56;
    let a = Number(canvas.dataset.a), b = Number(canvas.dataset.b);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
        const win = panelWindow(p, line.wordsOf()[selected]);
        a = win.a; b = win.b;
    }
    if (p.from < a) a = Math.max(0, p.from - CONTEXT);
    if (p.until > b) b = p.until + CONTEXT;
    canvas.dataset.a = String(a);
    canvas.dataset.b = String(b);
    canvas.dataset.from = String(p.from);
    canvas.dataset.until = String(p.until);
    const wv = waves.wave(p.hit.vod.media, a, b, Math.max(64, Math.round(w / 2)));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14171c';
    ctx.fillRect(0, 0, w, h);
    const scale = w / (b - a);
    const x0 = (p.from - a) * scale, x1 = (p.until - a) * scale;
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    if (wv && !wv.error) paintWave(ctx, wv, 0, w, h - TICK_H, [x0, x1]);
    paintTicks(ctx, a, b, w, h, p.from - line.headOf(selected));
    ctx.fillStyle = '#ff9a4a';
    for (const x of [Math.round(x0), Math.round(x1) - 1]) {
        ctx.fillRect(x, 0, 2, h);
        ctx.fillRect(x - 3, 0, 8, 4);
        ctx.fillRect(x - 3, h - 4, 8, 4);
    }
}

function paintTicks(ctx, a, b, w, h, zero) {
    const scale = w / (b - a);
    const top = h - TICK_H;
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(0, top, w, TICK_H);
    const first = Math.ceil((a - zero) / 0.1);
    const last = Math.floor((b - zero) / 0.1);
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    for (let k = first; k <= last; k++) {
        const t = zero + k * 0.1;
        const x = Math.round((t - a) * scale);
        const major = k % 5 === 0;
        ctx.fillStyle = major ? 'rgba(255,255,255,.45)' : 'rgba(255,255,255,.18)';
        ctx.fillRect(x, top, 1, major ? TICK_H : 4);
        if (major && k !== 0) {
            ctx.fillStyle = 'rgba(255,255,255,.4)';
            ctx.fillText(`${k > 0 ? '' : '−'}${Math.abs(k) / 10}`, x + 3, top + 1);
        }
    }
}

let takePage = { i: -1, page: 0, take: 0 };

function takesOf(p) {
    const selected = rctx.selected();
    const list = p.candidates || [];
    const pages = Math.max(1, Math.ceil(list.length / TAKES_A_PAGE));
    const at = list.findIndex((c) => c.take === p.take);
    const own = Math.floor(Math.max(0, at) / TAKES_A_PAGE);
    if (takePage.i !== selected || takePage.take !== p.take) takePage = { i: selected, page: own, take: p.take };
    takePage.page = Math.max(0, Math.min(pages - 1, takePage.page));
    const page = takePage.page;
    const shown = list.slice(page * TAKES_A_PAGE, (page + 1) * TAKES_A_PAGE);
    const kids = shown.map((c) => el('button', {
        cls: 'tiny l-takebtn' + (c.take === p.take ? ' on' : ''),
        text: `${c.take}`,
        title: `${Math.round(c.dur * 1000)} ms · ${c.score}%`,
        on: { click: () => { line.setTake(selected, c.take); rctx.redraw(); rctx.hear(selected); } },
    }));
    if (pages > 1) {
        const turn = (d) => {
            takePage = { i: selected, page: Math.max(0, Math.min(pages - 1, page + d)), take: p.take };
            rctx.redrawPanel();
        };
        kids.push(el('span', { cls: 'spacer' }));
        kids.push(el('button', { cls: 'tiny text l-takepage', id: 'l-takes-prev', text: '‹', title: 'Earlier takes',
                                 disabled: page === 0, on: { click: () => turn(-1) } }));
        kids.push(el('span', { cls: 'dim l-takeno', text: `${page * TAKES_A_PAGE + 1}–${page * TAKES_A_PAGE + shown.length} of ${list.length}` }));
        kids.push(el('button', { cls: 'tiny text l-takepage', id: 'l-takes-next', text: '›', title: 'Later takes',
                                 disabled: page >= pages - 1, on: { click: () => turn(1) } }));
    }
    return div('l-line l-takes', kids);
}

function nearest(phrase) {
    const key = bare(phrase);
    if (!library.available() || !library.current()) return [];
    for (let n = key.length; n >= 2; n--) {
        const got = library.suggest(key.slice(0, n), 5).filter((s) => s.word !== key);
        if (got.length) return got;
    }
    return [];
}

export function syncBox() {
    const box = document.getElementById('l-text');
    if (box) box.value = line.textOf();
}

export function remove(i) {
    rctx.stopWordLoop();
    if (rctx.playingWord() === i) rctx.hush();
    line.removeWord(i);
    rctx.clearSelectionState();
    syncBox();
    rctx.drawControls();
    rctx.redraw();
}

// ── the mix, selection, frame loop, and keys ───────────────────────────────

export function commit() {
    rctx.stopAll();
    line.say();
    syncBox();
    const did = line.commit();
    rctx.drawControls();
    rctx.redraw();
    return did;
}

export function selectedWord() { return rctx.selected(); }
export function sectionOf() { const s = rctx.section(); return s ? { ...s } : null; }

export function select(i) {
    const n = line.count();
    rctx.setSection(null);
    if (i < 0) { rctx.setSelected(-1); rctx.draw(); return true; }
    if (i >= n) return false;
    rctx.setSelected(i);
    rctx.hear(i);
    rctx.draw();
    return true;
}

export function selectRelative(delta, extend = false) {
    const n = line.count();
    if (!n) return false;
    const selected = rctx.selected();
    const section = rctx.section();
    const cur = selected >= 0 ? selected : (delta > 0 ? -1 : n);
    const next = Math.max(0, Math.min(n - 1, cur + delta));
    if (extend) {
        rctx.setSection({ a: section ? section.a : (selected >= 0 ? selected : next), b: next });
        rctx.setSelected(next);
        rctx.drawControls();
        rctx.draw();
        return true;
    }
    return select(next);
}

export function cycleTake(delta = 1) {
    let selected = rctx.selected();
    if (selected < 0) {
        if (!line.count()) return false;
        selected = 0;
        rctx.setSelected(0);
    }
    line.cycleTake(selected, delta);
    rctx.redraw();
    rctx.stopWordLoop();
    rctx.hear(selected);
    return true;
}

export function nudge(deltaSec) {
    const selected = rctx.selected();
    if (selected < 0) return 0;
    const v = line.nudge(selected, deltaSec);
    rctx.redraw();
    rctx.hear(selected);
    return v;
}

let busyWas = false;
export function repaint() {
    rctx.drawNote();
    if (waves.poll()) paintAll();
    if (line.busy() !== busyWas) { busyWas = line.busy(); rctx.drawControls(); }
}

export function reload() {
    line.replan();
    rctx.redraw();
}

export function arrive() {
    rctx.draw();
    syncBox();
    const box = document.getElementById('l-text');
    if (box) box.focus();
}

export function leave() { rctx.stopAll(); }

export function key(e) {
    if (e.key === ' ') {
        if (rctx.isSaying()) rctx.stopSay();
        else if (rctx.isWordLooping()) rctx.stopWordLoop();
        else if (rctx.playingWord() >= 0) rctx.hush();
        else rctx.say();
        rctx.redrawPanel();
        return true;
    }
    if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) { commit(); return true; }
        const box = document.getElementById('l-text');
        if (box) { box.focus(); return true; }
        return false;
    }
    if (e.key === 'l' || e.key === 'L') { rctx.toggleLooping(); return true; }
    if (e.key === 'ArrowLeft') { selectRelative(-1, e.shiftKey); return true; }
    if (e.key === 'ArrowRight') { selectRelative(1, e.shiftKey); return true; }
    if (e.key === '[') { cycleTake(-1); return true; }
    if (e.key === ']') { cycleTake(1); return true; }
    if (e.key === ',' || e.key === '<') { nudge(e.shiftKey ? -0.025 : -0.005); return true; }
    if (e.key === '.' || e.key === '>') { nudge(e.shiftKey ? 0.025 : 0.005); return true; }
    const selected = rctx.selected();
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) {
        const idx = rctx.sectionIndices();
        if (idx && idx.length > 1) {
            for (let i = idx[idx.length - 1]; i >= idx[0]; i--) line.removeWord(i);
            rctx.clearSelectionState();
            syncBox();
            rctx.drawControls();
            rctx.redraw();
        } else {
            remove(selected);
        }
        return true;
    }
    if (e.key === 'Escape' && (rctx.section() || selected >= 0)) {
        rctx.clearSelectionState();
        rctx.drawControls();
        rctx.redraw();
        return true;
    }
    return false;
}
