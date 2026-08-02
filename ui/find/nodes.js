// The kinds of node the Find stage has, and what each one computes.
//
// One table, and everything else on the stage reads it: the card draws a node
// from `params`, the panel builds its fields from `fields`, the layout counts
// its sockets from `ins`/`outs`, the evaluator calls `run`, and the note under
// the card is `note`. A kind added here is a kind the whole stage has, which is
// the property that makes the next one — a vision finder over the picture —
// an entry rather than a project.
//
// **Two things travel on a wire and they are not interchangeable.** An `input`
// is a recording; a `stack` is an ordered list of candidates (`ui/find/stack.js`).
// A finder is exactly the node that turns the first into the second, which is
// why it is the only place a soundtrack is read at all, and why every node after
// it is arithmetic on lists that never touches a file. The socket colours say
// which is which and `accepts()` is what refuses a wire between them — the same
// job `ui/graph/derive.js` does when it refuses rather than approximates.
//
// **A finder reads what has already been read and never starts a read.** A word
// search wants a transcript and a sound rule wants a marks pass, both of which
// are minutes to hours of machine (`ui/transcript.js` says why the read is asked
// for and never automatic). So a finder over an input nothing has listened to
// answers with an empty stack and a note saying which press is missing, and the
// note is a *statement* in `ui/export/explain.js`'s sense — it changes with the
// state and is the answer to the question somebody is holding.
//
// **Every `run` is pure.** It takes the values on its input wires and answers
// with its output value; it reads the transcript and the marks through `ctx`
// rather than importing them, which is what lets `tests/ui_find.js` evaluate a
// whole graph against a made-up transcript with no file, no read and no screen.

import * as S from './stack.js';

/// What a wire can carry. Two, and the second is the one the stage is about.
export const INPUT = 'input';
export const STACK = 'stack';

/// Can a wire leaving a `from` port land on a `to` port? The one test, so the
/// canvas, the drag and the model cannot come to disagree about it.
export const accepts = (fromKind, toKind) => fromKind === toKind;

/// Seconds a `said` candidate carries either side by default — `stack.js`'s
/// `PAD_MIN`, which is `ui/transcript.js`'s `WINDOW_PAD`, which is the measured
/// distance between a VOD's two renditions. Restated nowhere.
const SAID_PAD = S.PAD_MIN;

/// A number out of a param, with a default for the empty field. Fields are text
/// because a spinner cannot be left blank, and blank has to mean "the default"
/// rather than zero — a pad of nothing is a legitimate setting and so is not
/// having said.
function num(v, fallback = 0) {
    if (v === '' || v === null || v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

// ── the table ─────────────────────────────────────────────────────────────

export const KINDS = {

    // ── where the material comes from ──────────────────────────────────────

    source: {
        title: 'Recording',
        ins: [],
        outs: [INPUT],
        // A `source` names an input by id rather than holding it, for
        // `ui/document.js`'s reason: an id is what survives a save and an open,
        // and `useInputId` is what stops an open renumbering one out from
        // under a graph that points at it.
        params: { inputId: '' },
        fields: [{ key: 'inputId', label: 'Input', kind: 'input' }],
        run: (node, _ins, ctx) => ctx.inputById(node.params.inputId) || null,
        label: (node, ctx) => {
            const i = ctx.inputById(node.params.inputId);
            return i ? i.name : 'no recording chosen';
        },
        note: (node, value) => (value ? '' : 'choose a recording'),
    },

    // ── the finders: a recording in, a stack out ───────────────────────────

    said: {
        title: 'Said',
        ins: [INPUT],
        outs: [STACK],
        params: { phrase: '', pad: String(SAID_PAD), whole: false },
        fields: [
            { key: 'phrase', label: 'Words', kind: 'text',
              placeholder: 'a word or a phrase' },
            { key: 'pad', label: 'Either side', kind: 'number', unit: 's' },
            { key: 'whole', label: 'Whole words only', kind: 'flag' },
        ],
        /// Every place a phrase was said, as a padded span each.
        ///
        /// **The pad is not a comfort margin and the field says so.** A
        /// transcript is read from whatever soundtrack was cheapest — for a
        /// Twitch VOD the audio-only rendition — and the picture rendition it
        /// will be cut from does not share its zero, measured at up to +2.57 s
        /// on one recording. A span cut to the word boundary would sometimes
        /// not contain the word. Ten seconds is the measurement; it can be
        /// lowered, and the note says what that costs.
        run: (node, ins, ctx) => {
            const input = ins[0];
            if (!input) return [];
            const phrase = String(node.params.phrase || '').trim();
            if (!phrase) return [];
            const pad = Math.max(0, num(node.params.pad, SAID_PAD));
            const dur = ctx.durationOf(input.id);
            const hits = ctx.search(input.id, phrase, !!node.params.whole);
            return hits.map((h) => {
                const c = S.candidate(input.id,
                                      Math.max(0, h.start - pad),
                                      dur > 0 ? Math.min(h.end + pad, dur) : h.end + pad,
                                      'said', trimmed(h.text));
                // Where the words are inside the padded span, so a row can say
                // "ten seconds in" and a person knows what they are looking at.
                c.at = h.start;
                return c;
            });
        },
        label: (node) => {
            const p = String(node.params.phrase || '').trim();
            return p ? `"${p}"` : 'no words yet';
        },
        note: (node, value, ctx, ins) => {
            const input = ins[0];
            if (!input) return 'wire a recording in';
            const cov = ctx.coverageOf(input.id);
            if (!cov) return 'nothing has transcribed this recording — Transcribe it on Sources';
            if (!String(node.params.phrase || '').trim()) return 'type a word to look for';
            const bits = [];
            if (cov.read < cov.duration - 0.5)
                bits.push(`only the first ${S.showTime(cov.read)} of ` +
                          `${S.showTime(cov.duration)} has been read`);
            const pad = num(node.params.pad, SAID_PAD);
            if (pad < SAID_PAD)
                bits.push(`${pad}s either side is under the ${SAID_PAD}s the two ` +
                          `renditions were measured apart — a span may not contain its word`);
            return bits.join(' · ');
        },
    },

    sound: {
        title: 'Sound',
        ins: [INPUT],
        outs: [STACK],
        // `sound` — a run above the measured noise floor — is the default
        // because it is the one of the three that is already a *span*, and so
        // the one that answers "where is somebody talking for a while" without
        // anything after it. The words are `ui/marks.js`'s `MARK_WORDS` and are
        // not restated: that object is the one home of what a mark measured and
        // `tests/ui_marks.js` refuses any copy of it that names a source.
        params: { mark: 'sound', min: '4', max: '', hz: '' },
        fields: [
            { key: 'mark', label: 'Kind', kind: 'mark' },
            // **Absent on a transient, because a transient has no length.** An
            // `onset` is an instant — the native side reports zero — so a bound
            // on it is not a filter that passes everything, it is a filter that
            // passes *nothing*, and the default of four seconds silently emptied
            // the branch while the card read "onset over 4s". A control that
            // cannot do anything is one more thing to read past
            // (`ui/export/explain.js`); a control that quietly destroys the
            // result is worse than that, and this is the second kind.
            { key: 'min', label: 'At least', kind: 'number', unit: 's', notFor: 'onset' },
            { key: 'max', label: 'At most', kind: 'number', unit: 's', notFor: 'onset' },
            { key: 'hz', label: 'Around', kind: 'number', unit: 'Hz', only: 'tonal' },
        ],
        run: (node, ins, ctx) => {
            const input = ins[0];
            if (!input) return [];
            const want = String(node.params.mark || 'sound');
            const marks = ctx.marksOf(input.id);
            if (!marks) return [];
            const min = Math.max(0, num(node.params.min, 0));
            const max = Math.max(0, num(node.params.max, 0));
            const hz = Math.max(0, num(node.params.hz, 0));
            // A transient is an instant, so a length bound cannot mean anything
            // about one — see the fields above. Ignored here rather than at the
            // field alone, because a document written while the kind was `sound`
            // still carries the four seconds after the kind is changed.
            const timed = want !== 'onset';
            const out = [];
            for (const m of marks) {
                if (m.kind !== want) continue;
                const len = m.length || 0;
                if (timed && min > 0 && len < min) continue;
                if (timed && max > 0 && len > max) continue;
                // A tenth either side of the asked-for pitch, which is about
                // what tells a hum from a whistle and is wide enough that
                // typing a round number finds the thing you heard.
                if (hz > 0 && Math.abs((m.hz || 0) - hz) > hz * 0.1) continue;
                const c = S.candidate(input.id, m.at, m.at + len, 'sound',
                                      detailOf(want, m));
                out.push(c);
            }
            return out;
        },
        label: (node) => {
            const kind = String(node.params.mark || 'sound');
            if (kind === 'onset') return 'every transient';
            const min = num(node.params.min, 0);
            return kind + (min > 0 ? ` over ${min}s` : '');
        },
        note: (node, value, ctx, ins) => {
            const input = ins[0];
            if (!input) return 'wire a recording in';
            if (!ctx.marksOf(input.id))
                return 'nothing has listened to this recording — Find sounds on Sources';
            // A transient has no length, so a stack of them is a stack of
            // moments and cutting it would produce clips of nothing. Said here
            // rather than fixed silently, because the fix is a Pad node and
            // saying so is what teaches the stage.
            if (node.params.mark === 'onset' && value && value.length)
                return 'transients are moments, not spans — put a Pad after this to ' +
                       'make them clips';
            return '';
        },
    },

    // ── shaping one stack ──────────────────────────────────────────────────

    pad: {
        title: 'Pad',
        ins: [STACK],
        outs: [STACK],
        params: { before: '1', after: '1' },
        fields: [
            { key: 'before', label: 'Before', kind: 'number', unit: 's' },
            { key: 'after', label: 'After', kind: 'number', unit: 's' },
        ],
        run: (node, ins, ctx) => S.padded(ins[0] || [], num(node.params.before, 0),
                                          num(node.params.after, 0), ctx.durationOf),
        label: (node) => `+${num(node.params.before, 0)}s / +${num(node.params.after, 0)}s`,
    },

    merge: {
        title: 'Merge',
        ins: [STACK],
        outs: [STACK],
        params: { gap: '0' },
        fields: [{ key: 'gap', label: 'Closer than', kind: 'number', unit: 's' }],
        run: (node, ins) => S.merged(ins[0] || [], num(node.params.gap, 0)),
        label: (node) => {
            const g = num(node.params.gap, 0);
            return g > 0 ? `within ${g}s` : 'overlapping';
        },
        note: (node, value, ctx, ins) => {
            const had = (ins[0] || []).length, got = (value || []).length;
            return had && got < had ? `${had - got} folded into their neighbours` : '';
        },
    },

    length: {
        title: 'Length',
        ins: [STACK],
        outs: [STACK],
        params: { min: '', max: '' },
        fields: [
            { key: 'min', label: 'At least', kind: 'number', unit: 's' },
            { key: 'max', label: 'At most', kind: 'number', unit: 's' },
        ],
        run: (node, ins) => S.within(ins[0] || [], num(node.params.min, 0),
                                     num(node.params.max, 0)),
        label: (node) => {
            const a = num(node.params.min, 0), b = num(node.params.max, 0);
            if (a && b) return `${a}–${b}s`;
            if (a) return `over ${a}s`;
            if (b) return `under ${b}s`;
            return 'any length';
        },
        note: (node, value, ctx, ins) => {
            const had = (ins[0] || []).length, got = (value || []).length;
            return had && got < had ? `${had - got} dropped` : '';
        },
    },

    order: {
        title: 'Order',
        ins: [STACK],
        outs: [STACK],
        params: { order: 'found', seed: '1' },
        fields: [
            { key: 'order', label: 'In', kind: 'order' },
            { key: 'seed', label: 'Shuffle', kind: 'seed', only: 'scattered' },
        ],
        run: (node, ins) => S.sorted(ins[0] || [], node.params.order,
                                     num(node.params.seed, 1)),
        label: (node) => String(node.params.order || 'found'),
        note: (node) => (node.params.order === 'found'
            ? 'the order the recording said them'
            : ''),
    },

    slice: {
        title: 'Some of',
        ins: [STACK],
        outs: [STACK],
        params: { from: '0', count: '' },
        fields: [
            { key: 'from', label: 'From', kind: 'number', unit: 'th' },
            { key: 'count', label: 'How many', kind: 'number' },
        ],
        run: (node, ins) => S.slice(ins[0] || [], num(node.params.from, 0),
                                    num(node.params.count, 0)),
        label: (node) => {
            const f = num(node.params.from, 0), c = num(node.params.count, 0);
            return c > 0 ? `${c} from ${f}` : `from ${f} on`;
        },
    },

    // ── putting two together ───────────────────────────────────────────────

    mix: {
        title: 'Mix',
        ins: [STACK, STACK],
        outs: [STACK],
        params: { takeA: '1', takeB: '3' },
        fields: [
            { key: 'takeA', label: 'Take of the first', kind: 'number' },
            { key: 'takeB', label: 'then of the second', kind: 'number' },
        ],
        run: (node, ins) => S.mixed(ins[0] || [], ins[1] || [],
                                    num(node.params.takeA, 1), num(node.params.takeB, 1)),
        label: (node) => `${num(node.params.takeA, 1)} : ${num(node.params.takeB, 1)}`,
        note: (node, value, ctx, ins) => {
            // `null` is a socket with no wire on it and `[]` is a stack that
            // arrived empty — `ui/find/model.js`'s walk says why they differ, and
            // this is the note that was wrong without it.
            if (!ins[0] || !ins[1]) return 'wire two stacks in';
            const a = ins[0].length, b = ins[1].length;
            if (!a && !b) return 'both are empty so far';
            // Which one ran out first is the thing you want to know about a
            // weave and cannot see in the result: past that point the ratio is
            // not what the card says any more.
            const na = Math.max(1, num(node.params.takeA, 1));
            const nb = Math.max(1, num(node.params.takeB, 1));
            const rounds = Math.min(Math.ceil(a / na), Math.ceil(b / nb));
            const kept = Math.min(a, rounds * na) + Math.min(b, rounds * nb);
            return kept < a + b
                ? `${a} and ${b} — the ratio holds for ${rounds}, then the longer one runs on`
                : `${a} and ${b}`;
        },
    },

    every: {
        title: 'Every',
        ins: [STACK, STACK],
        outs: [STACK],
        params: { n: '3' },
        fields: [{ key: 'n', label: 'After every', kind: 'number', unit: 'th' }],
        run: (node, ins) => S.everyNth(ins[0] || [], ins[1] || [], num(node.params.n, 3)),
        label: (node) => `every ${num(node.params.n, 3)}`,
        note: (node, value, ctx, ins) => {
            if (!ins[0] || !ins[1]) return 'the first is the spine, the second goes into it';
            const a = ins[0].length, b = ins[1].length;
            if (!a && !b) return 'both are empty so far';
            const room = Math.floor(a / Math.max(1, num(node.params.n, 3)));
            return b > room
                ? `${b} to place and room for ${room} — the rest go on the end`
                : `${b} placed into ${a}`;
        },
    },

    // ── the end ────────────────────────────────────────────────────────────

    stack: {
        title: 'Stack',
        ins: [STACK],
        outs: [],
        params: { name: '' },
        fields: [{ key: 'name', label: 'Called', kind: 'text', placeholder: 'a name' }],
        // A sink is the identity, which is what makes it a *place* rather than
        // an operation: what a stack holds is exactly what was wired into it,
        // and the node exists so that a run of the graph has a name, a count and
        // a press that puts it on the timeline.
        run: (node, ins) => ins[0] || [],
        label: (node) => String(node.params.name || 'unnamed'),
        note: (node, value) => (value && value.length ? S.summaryOf(value) : 'nothing in it'),
    },
};

/// Every kind, in the order they belong in a menu — which is the order the data
/// flows through them, for the reason the spine is in that order.
export const KIND_ORDER = ['source', 'said', 'sound', 'pad', 'merge', 'length',
                           'order', 'slice', 'mix', 'every', 'stack'];

/// The group a kind belongs to, for the Add menu's headings. Four words that say
/// what the stage does: find material, shape it, put it together, keep it.
export const GROUPS = {
    source: 'From', said: 'Find', sound: 'Find',
    pad: 'Shape', merge: 'Shape', length: 'Shape', order: 'Shape', slice: 'Shape',
    mix: 'Arrange', every: 'Arrange',
    stack: 'Keep',
};

export const kindOf = (node) => KINDS[node && node.kind] || null;

/// What a node's ports carry. Answered from the table rather than from the
/// wires, `ui/graph/model.js`'s rule: an unwired socket is a thing to be seen
/// and filled, and counting the wires would hide it.
export function portKinds(node, dir) {
    const k = kindOf(node);
    if (!k) return [];
    return dir === 'in' ? k.ins : k.outs;
}

/// A segment's words, short enough for a card. Whole, in the panel.
function trimmed(text) {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    return t.length > 64 ? t.slice(0, 63) + '…' : t;
}

/// What a mark's row says it was. The frequency only on a tonal run, for
/// `ui/marks.js` `markLabel`'s reason: `dominant_hz` on any other kind is
/// whatever the autocorrelation last liked, and printing it would be a
/// measurement nobody made.
function detailOf(kind, m) {
    if (kind === 'tonal') return `${Math.round(m.hz || 0)} Hz, ${(m.length || 0).toFixed(1)}s`;
    if (kind === 'sound') return `${(m.length || 0).toFixed(1)}s above the floor`;
    return 'a transient';
}
