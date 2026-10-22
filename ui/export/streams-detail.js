// Stream detail facets (span, keyframes, cues, naming, flags, metadata,
// bitstream filter packet chain) and chapter/metadata rows for
// `ui/export/streams.js`.

import { el, div, span, select, row, segmented } from '../dom.js';
import { basename } from '../format.js';
import { lengthOf as inputLength } from '../inputs.js';
import { settings } from './state.js';
import { videoEncoders, audioEncoders, dispositions, codecTags } from './capabilities.js';
import { optionColumn } from '../opttable.js';
import { parseCopy, isCopy, copiedStream, copiedInput,
         keyframesFor, keyframeAtOrBefore, inPointNote,
         timelineSpan, clipSpan, followedClip, follow, unfollow,
         brokeFollowing } from './copy.js';
import { isDecode, readsInput, readInput,
         cuesFor, cueWindow, cueWindowNote,
         cueTextFor, cueSaying } from './subtitles.js';

let ctx = null;
export function bindStreamsDetailContext(c) { ctx = c; }

/// Move a row between the three things it can be fed from.
///
/// The encoder choice is dropped on the way into a copy, because a copied stream
/// has no encoder and a `codec` left on one is refused by the renderer — rightly,
/// since it would be a setting that did nothing. The span is dropped on the way
/// out for the same reason in reverse.
///
/// **A pad-fed row keeps its encoder**, and that is the whole difference between
/// it and a copy: it is an encoded stream whose pictures happen to come from the
/// middle of a graph rather than from the composite. What it drops is the span,
/// which belongs to a row that reads an input and means nothing here.
export function setSource(s, source) {
    s.source = source;
    if (isCopy(s)) {
        s.codec = '';
        s.bsf = s.bsf || [];
        s.tag = '';
    } else if (s.kind !== 'subtitle') {
        // A converted subtitle track keeps its window: `copyFrom` says where
        // the reading starts and where the output's zero is, which is the same
        // decision whether the cues are copied or written again. Only a
        // *composed* stream has no window, because its zero is the range's.
        s.copyFrom = 0;
        s.copyTo = 0;
    }
    ctx.setOpenDetail(s.id);
    // **And back to the first facet, because the source is what decides there is
    // one.** Moving a row onto a copy is what gives it a span to trim and a
    // keyframe list to trim against; leaving the strip on whichever tab the last
    // row was open at would hide the one thing this press just made relevant.
    ctx.setOpenFacet('');
    ctx.syncAudioFlag();
    ctx.changed();
}

/// Everything the row is not spending a control on, as the words a player
/// would use. Rewritten in place when the detail changes, so typing a language
/// does not rebuild the list under the caret.
export function tailOf(s) {
    const bits = [];
    if (s.kind === 'attachment') {
        if (s.path) bits.push(basename(s.path));
        if (s.mimeType) bits.push(s.mimeType);
        return bits.join(' · ');
    }
    // The span a copy takes, in the input's own seconds — which is what the
    // renderer is given and what `-ss`/`-to` in the command say. Written before
    // the metadata because it is the part of the sentence that changes what is
    // in the file.
    if (isCopy(s) || (s.kind === 'subtitle' && isDecode(s))) {
        const from = Number(s.copyFrom) || 0;
        const to = Number(s.copyTo) || 0;
        if (from > 0 || to > 0)
            bits.push(`${from.toFixed(2)} s → ${to > 0 ? to.toFixed(2) + ' s' : 'the end'}`);
        else bits.push('all of it');
    }
    if (s.language) bits.push(s.language);
    if (s.title) bits.push(`“${s.title}”`);
    for (const d of (s.disposition || '').split(/[+, ]+/).filter(Boolean)) bits.push(d);
    if (s.tag) bits.push(s.tag);
    // The chain, in order and as the command line spells it, because the order
    // is the meaning and a count would hide it.
    const chain = (s.bsf || []).filter((b) => b.name).map((b) => b.name);
    if (chain.length) bits.push(`bsf ${chain.join(',')}`);
    return bits.join(' · ');
}

// ── the facets of one stream ───────────────────────────────────────────────
//
// A stream has five kinds of thing to say about it and they are independent:
// what part of the source it takes, what it is called, what a player should do
// with it, what travels beside it, and what happens to its packets on the way
// to the muxer. Nobody edits two of them at once — a language and a bitstream
// filter have nothing to do with each other — so they are drawn one at a time.
//
// **The strip says which of them carry anything**, which is the half of this
// that is worth more than the height it saves: `Flags · 2` on a closed facet is
// the answer to "what has been set on this row" without opening any of them,
// and the row's own tail already says *what* those two are.

/// The facets this row has, in the order they are decided in.
///
/// A kind that cannot have one does not get an empty tab: a data stream has no
/// packet chain, because a bitstream filter reworks a *codec's* packets and a
/// track nothing decodes has no codec for one to be written against.
function facetsOf(s) {
    const out = [];
    const span = spanFacet(s);
    if (span) out.push(span);
    out.push({ v: 'naming', l: 'Naming', title: 'Naming' });
    out.push({ v: 'flags', l: 'Flags', title: 'Flags' });
    out.push({ v: 'metadata', l: 'Metadata', title: '-metadata:s: on this stream' });
    if (s.kind !== 'data')
        out.push({ v: 'packets', l: 'Packets', title: 'Packets' });
    return out.map((f) => {
        const n = facetCount(s, f.v);
        return n ? Object.assign({}, f, { l: `${f.l} · ${n}` }) : f;
    });
}

/// The first facet, which is a window on the source and is not always there: a
/// composed stream takes the whole render range and has nothing to trim.
function spanFacet(s) {
    if (s.kind === 'subtitle') {
        if (!readsInput(s)) return null;
        return { v: 'span', l: 'Cues', title: 'Cues' };
    }
    if (!isCopy(s)) return null;
    return { v: 'span', l: 'Span', title: 'Span' };
}

/// How many things are set on a facet, for the badge on its tab.
function facetCount(s, id) {
    switch (id) {
        case 'naming': return [s.language, s.title, s.tag].filter(Boolean).length;
        case 'flags': return (s.disposition || '').split(/[+, ]+/).filter(Boolean).length;
        case 'metadata': return Object.keys(s.metadata || {}).length;
        case 'packets': return (s.bsf || []).filter((b) => b.name).length;
        default: return 0;
    }
}

export function detailRows(s, tail) {
    const restate = () => { tail.textContent = tailOf(s); ctx.restated(); };

    // **An attachment is not faceted**, because it has one control. It is a
    // stream with no packets in it — nothing to trim, nothing to filter, and a
    // disposition on a font is a disposition nothing reads — so a strip of five
    // tabs over one field would be the shape of the thing lying about it.
    if (s.kind === 'attachment') {
        const mime = el('input', {
            cls: 'wide', 'data-f': 'attach-mime', type: 'text', value: s.mimeType || '',
            placeholder: 'guessed from the name',
            on: { change: (e) => { s.mimeType = e.target.value.trim(); restate(); } },
        });
        return [
            div('ex-facets', [span('Attachment', 'ex-facet-one')]),
            row('Mime type', mime),
        ];
    }

    const facets = facetsOf(s);
    const openFacet = ctx.openFacet();
    const cur = facets.find((f) => f.v === openFacet) || facets[0];
    return [
        div('ex-facets', [
            segmented('facet', facets, cur.v, (v) => { ctx.setOpenFacet(v); ctx.drawStreams(); }),
        ]),
        ...facetRows(s, cur.v, restate),
    ];
}

function facetRows(s, id, restate) {
    switch (id) {
        case 'span': return copyRows(s, restate);
        case 'naming': return namingRows(s, restate);
        case 'flags': return [
            row('Flags', dispositionToggles(s, restate)),
        ];
        case 'metadata': return [
            ...pairRows(s.metadata, `s${s.id}`, restate),
        ];
        case 'packets': return bsfRows(s, restate);
    }
    return [];
}

/// What the stream is called, and what the muxer writes as its fourcc.
function namingRows(s, restate) {
    const lang = el('input', {
        cls: 'num', 'data-f': 'stream-lang', type: 'text', value: s.language || '',
        placeholder: 'eng', maxlength: 3,
        on: { change: (e) => { s.language = e.target.value.trim(); restate(); } },
    });
    const title = el('input', {
        cls: 'wide', 'data-f': 'stream-title', type: 'text', value: s.title || '',
        placeholder: 'what a track menu shows',
        on: { change: (e) => { s.title = e.target.value; restate(); } },
    });
    return [
        row('Language', [lang, span('ISO 639-2', 'dim')]),
        row('Name', title),
        ...tagRow(s, restate),
    ];
}

// ── What a copy takes, and where it can start ──────────────────────────────
//
// **A copy can only begin at a keyframe**, and that is the one fact about the
// packet path a person has to hold. Everything else about a copy is a saving;
// this is the cost, and it is a cost that is invisible until the file is open
// in a player and starts a second and a half early.
//
// So the keyframes are on the screen, as the places they are. The strip is the
// input's own clock with a mark per keyframe, the in-point is drawn against
// them, and clicking a mark is how the cut is snapped to one. Underneath, in
// words, what the current in-point costs — because a strip answers "where" and
// only a sentence answers "and what does that mean".

function copyRows(s, restate) {
    // **A subtitle stream has no keyframes**, and for a while that was taken to
    // mean there was nothing to draw a window against. Every cue does stand on
    // its own — a moment with text on it, not a frame that depends on the one
    // before — but where those moments *are* is exactly what the two numbers
    // have to be read against, and a copy and a conversion cut differently out
    // of the same pair. So the cues are on screen, as the places they are.
    if (s.kind === 'subtitle') {
        if (!readsInput(s)) return [];
        readInput(s);
        return [
            row('From', [subNum(s, 'copyFrom', restate),
                         span('seconds into the file', 'dim')]),
            row('To', [subNum(s, 'copyTo', restate), span('0 is the end of it', 'dim')]),
            ...cueRows(s, restate),
        ];
    }
    if (!isCopy(s)) return [];

    const stream = copiedStream(s);
    const input = copiedInput(s);
    const isData = !!stream && stream.kind === 'data';
    // `lengthOf`, not a copy of it minus a term: an input's length is its video
    // stream's own duration where there is one and the container's otherwise,
    // and a container that reports none where the stream does gave the keyframe
    // strip a span of zero to draw the in-point against.
    const total = input ? inputLength(input) : 0;

    const num = (key, placeholder) => el('input', {
        cls: 'num', 'data-f': `copy-${key}`, type: 'number', min: 0, step: 0.1,
        value: Number(s[key]) || 0, placeholder,
        on: { change: (e) => {
            s[key] = Math.max(0, Number(e.target.value) || 0);
            // Restated first, then redrawn. `restate` closes over the tail of
            // the row it was made for, and `drawStreams()` has just detached
            // it — harmless only because the redraw recomputes the same text,
            // which is not a thing to leave lying about. `bsfRows` already
            // does it this way round.
            restate();
            ctx.drawStreams();
        } },
    });

    const out = [
        row('From', [num('copyFrom', '0'), span('seconds into the input', 'dim')]),
        row('To', [num('copyTo', '0'), span('0 is the end of it', 'dim')]),
        ...followRow(s, restate),
    ];

    if (isData) {
        return out;
    }

    if (stream && stream.kind === 'audio') {
        return out;
    }

    const list = keyframesFor(s);
    if (!list || !list.times.length) {
        out.push(div('ex-note dim',
            'Where this stream’s keyframes are could not be read, so the copy will begin ' +
            'at the keyframe at or before the in-point without this being able to say ' +
            'where that is.'));
        return out;
    }

    const want = Number(s.copyFrom) || 0;
    const land = keyframeAtOrBefore(list, want);
    const span0 = Math.max(total, list.times[list.times.length - 1] + 1);

    out.push(row('Keyframes', keyframeStrip(s, list, span0, restate)));
    out.push(div('ex-copy-note' + (land !== null && want - land > 0.001 ? ' warn' : ' dim'),
                 inPointNote(s)));
    if (land !== null && want - land > 0.001)
        out.push(div('ex-add', el('button', {
            cls: 'tiny', text: `Snap to ${land.toFixed(2)} s`, 'data-f': 'copy-snap',
            title: 'Snap to keyframe',
            on: { click: () => { s.copyFrom = land; restate(); ctx.drawStreams(); } },
        })));

    const last = list.times[list.times.length - 1];
    out.push(div('ex-note dim',
        `${list.times.length} keyframe${list.times.length === 1 ? '' : 's'}, from the ` +
        `${list.how === 'index' ? 'demuxer’s own index' : 'packets, read'}` +
        `${list.complete ? '' : ` — and the reading stopped at ${last.toFixed(2)} s, ` +
                                'so there are more further in'}.`));
    return out;
}

function followRow(s, restate) {
    const at = parseCopy(s.source);
    if (!at) return [];

    const bound = followedClip(s);
    if (bound) {
        const held = clipSpan(bound);
        return [
            row('Following', [
                span(`${bound.name} · ${held.from.toFixed(2)} → ${held.to.toFixed(2)} s`, 'mono'),
                el('button', {
                    cls: 'tiny', 'data-f': 'copy-unfollow', text: 'Stop following',
                    title: 'Stop following',
                    on: { click: () => { unfollow(s); restate(); ctx.drawStreams(); } },
                }),
            ]),
        ];
    }

    // A link that broke, said where it cannot be shouted over. The act that
    // breaks one is nearly always a deletion, and a deletion says "Removed
    // landscape.mp4" of its own accord a moment later — so the flash is the notice
    // and this is the record of it.
    const lost = brokeFollowing(s)
        ? el('div', { cls: 'ex-copy-note warn', 'data-f': 'copy-broke', text:
              'This row was following a clip on the timeline and that clip has gone. The two ' +
              'numbers above are the ones it last took, unchanged — breaking a link is not ' +
              'undoing the trim — so what is copied is still what it says.' })
        : null;

    const { span: sp, reason } = timelineSpan(at.input);
    if (!sp)
        return [lost, reason ? div('ex-note dim',
                                   `The clip’s own span is not offered: ${reason}.`) : null];
    const already = Math.abs((Number(s.copyFrom) || 0) - sp.from) < 0.001 &&
                    Math.abs((Number(s.copyTo) || 0) - sp.to) < 0.001;
    return [
        lost,
        div('ex-add', el('button', {
            cls: 'tiny', 'data-f': 'copy-follow',
            text: `Follow the clip (${sp.from.toFixed(2)} → ${sp.to.toFixed(2)} s)`,
            title: 'Follow clip',
            on: { click: () => { follow(s, sp.clip); restate(); ctx.drawStreams(); } },
        })),
        // What the press is about *now*: the numbers may already be these ones,
        // and following is still worth pressing, because what it adds is that
        // they stay these ones. A statement about this row's current numbers, so
        // it stays — cut to the one clause that says why the button is still
        // worth pressing, which is the whole of what somebody looking at a
        // button that appears to do nothing needs.
        already
            ? div('ex-note dim',
                  'Already the numbers that clip says — following keeps them so when it ' +
                  'is trimmed again.')
            : sp.whole
                ? div('ex-note dim',
                      'That clip is the whole input — following changes nothing until it ' +
                      'is trimmed.')
                : null,
    ];
}

/// One of a subtitle row's two window numbers. The same control the copy rows
/// use, and now with the same redraw: the cues below are drawn against this
/// number, so a window typed rather than clicked has to repaint them or the
/// marks go on describing the previous one.
function subNum(s, key, restate) {
    return el('input', {
        cls: 'num', 'data-f': `copy-${key}`, type: 'number', min: 0, step: 0.1,
        value: Number(s[key]) || 0,
        on: { change: (e) => {
            s[key] = Math.max(0, Number(e.target.value) || 0);
            // `restate` ends in `hooks.restated()` already; saying it twice ran
            // the whole warnings pass twice on every keystroke.
            restate();
            ctx.drawStreams();
        } },
    });
}

/// The cues, and what this row's window does to them.
///
/// The subtitle answer to the keyframe strip, and drawn as a **list** rather
/// than as a strip on purpose: a cue is a span with a length worth reading, the
/// count is small enough to write out, and the useful question is which of them
/// survive the window rather than where they sit proportionally. Each is a
/// button, because moving the in-point onto a cue is the fix for nearly
/// everything this section has to report.
///
/// **And each says what it says**, which is a second read of the file and is
/// what makes the list answer the question somebody actually has: not "is there
/// a cue at 4.5 s" but "which line am I cutting into". The words come from
/// `cueTextFor` — a decoder per track, alive while this stage is — and where
/// there are none the reason is written in their place, because a `dvdsub` cue is
/// a picture with no characters in it and a blank column would read as a track
/// this panel failed to read.
function cueRows(s, restate) {
    const list = cuesFor(s);
    if (!list)
        return [div('ex-note dim',
                    'Where this track’s cues are could not be read, so what the window does ' +
                    'to them cannot be said here — the render still cuts it the same way.')];
    if (!list.cues.length)
        return [div('ex-note dim', 'This track has no cues in it.')];

    const w = cueWindow(s, list);
    const shown = nearestCues(list.cues, w);
    const kept = new Set(w.kept);
    const first = w.kept.length ? w.kept[0] : null;
    const time = (t) => `${t.toFixed(2)}`;
    // The words, or the reason there are none. Asked once for the whole list
    // rather than per mark: it is one decode of one track, and sixteen calls
    // would be sixteen.
    const words = cueTextFor(s);
    const saying = words && words.textSub ? words : null;

    const marks = shown.map((c) => {
        const said = saying ? cueSaying(saying, c.start) : '';
        const when = c.end > c.start + 1e-6 ? `${time(c.start)}–${time(c.end)}` : time(c.start);
        const where = kept.has(c)
            ? (c === first ? 'The output starts on this cue' : 'Inside the window')
            : 'Outside the window — start here to take it in';
        return el('button', {
            cls: 'ex-cue' + (c === first ? ' on' : '') + (kept.has(c) ? '' : ' out'),
            'data-cue': c.start.toFixed(3),
            // The whole of it in the tooltip and a line of it on the screen: a
            // cue can be a paragraph, and a list of paragraphs is not a list.
            title: said ? `${when} s\n${said}` : where,
            on: { click: () => { s.copyFrom = c.start; restate(); ctx.drawStreams(); } },
        }, said ? [span(when, 'ex-cue-at'), span(oneLine(said), 'ex-cue-said')]
                : [span(when, 'ex-cue-at')]);
    });

    // Laid out as one cue per line where there are words to read and as a
    // wrapped row of times where there are not, which is the same list either
    // way — the times are what a `dvdsub` track has and they still snap.
    const out = [row('Cues', div('ex-cues' + (saying ? ' words' : ''), marks))];
    if (words && !words.textSub)
        out.push(div('ex-copy-note dim',
            `This track is ${words.codec}, which carries pictures of characters rather than ` +
            'characters — so there is nothing to read out of it, and when each picture is on ' +
            'screen is the whole of what can be said about one. It can be carried into a ' +
            'container that holds it; it cannot be converted, and it cannot be burned in, ' +
            'because libavfilter’s subtitles filter is libass and libass reads characters.'));
    else if (!words)
        out.push(div('ex-copy-note dim',
            'What these cues say could not be read. The times are off the packets and are ' +
            'unaffected, so the window still cuts where it says it does.'));
    out.push(div('ex-copy-note' + (w.slip > 0.001 || (w.converting && w.onScreen) ? ' warn' : ' dim'),
                 cueWindowNote(s, list)));

    if (w.converting && w.onScreen)
        out.push(div('ex-add', el('button', {
            cls: 'tiny', text: `Start at ${time(w.onScreen.start)} s`, 'data-f': 'cue-snap',
            title: 'Start at cue',
            on: { click: () => { s.copyFrom = w.onScreen.start; restate(); ctx.drawStreams(); } },
        })));
    else if (!w.converting && w.slip > 0.001)
        out.push(div('ex-add', el('button', {
            cls: 'tiny', text: `Snap to ${time(w.zero)} s`, 'data-f': 'cue-snap',
            title: 'Snap to cue',
            on: { click: () => { s.copyFrom = w.zero; restate(); ctx.drawStreams(); } },
        })));

    const total = list.cues.length;
    out.push(div('ex-note dim',
        `${total} cue${total === 1 ? '' : 's'}` +
        `${list.complete ? '' : ' at least — the list was cut short, so there are more'}. ` +
        (shown.length < total
            ? `${shown.length} are drawn, the ones the window’s ends fall among. `
            : '') +
        `This window keeps ${w.kept.length === total ? 'all of them' : w.kept.length}.`));
    return out;
}

/// A cue's words on one line, short enough to sit in a list.
///
/// A cue is two or three lines of dialogue and a `\N` in an ASS one is a break
/// the *author* asked for, so the newlines become a middle dot rather than
/// disappearing: "he said / and then he said" reads as two lines and "he saidand
/// then he said" reads as a typo. Cut at sixty characters, which is about the
/// longest subtitle line anybody writes; the whole of it is in the tooltip.
function oneLine(text) {
    const flat = String(text).replace(/\s*\n\s*/g, ' · ').trim();
    return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/// At most sixteen cues: the ones the window's two ends fall among.
///
/// A whole feature-length track is several hundred, and a panel of several
/// hundred buttons is not a list anybody reads. Cut by *nearness to the two
/// edges* rather than by taking the first sixteen, because the decision this
/// section exists for is always at an edge — and the count above says how many
/// were left out, since a list that quietly stops is one somebody would read
/// the end of as the end of the track.
function nearestCues(cues, w) {
    const CAP = 16;
    if (cues.length <= CAP) return cues;
    const end = w.to > 0 ? w.to : cues[cues.length - 1].start;
    const near = (edge) => cues
        .map((c, i) => ({ i, d: Math.abs(c.start - edge) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, CAP / 2)
        .map((x) => x.i);
    const want = new Set(near(w.from).concat(near(end)));
    return Array.from(want).sort((a, b) => a - b).map((i) => cues[i]);
}

/// The input's clock with a mark per keyframe, and the in-point against them.
///
/// Built rather than drawn into a canvas because there are a handful of marks
/// and each one is a thing to click: hit-testing ticks by hand to find out which
/// was meant is work with a DOM node's name on it, which is the same argument
/// the Graph stage's `+` is placed by.
function keyframeStrip(s, list, span0, restate) {
    const want = Number(s.copyFrom) || 0;
    const at = (t) => `${Math.max(0, Math.min(100, (t / (span0 || 1)) * 100))}%`;
    const marks = list.times.map((t) => el('button', {
        cls: 'ex-kf' + (Math.abs(t - want) < 0.001 ? ' on' : ''),
        'data-kf': t.toFixed(3),
        title: `${t.toFixed(2)} s`,
        style: { left: at(t) },
        on: { click: () => { s.copyFrom = t; restate(); ctx.drawStreams(); } },
    }));
    return div('ex-kf-strip', [
        div('ex-kf-track', marks),
        el('div', { cls: 'ex-kf-here', style: { left: at(want) } }),
    ]);
}

// ── the packet chain ───────────────────────────────────────────────────────
//
// A bitstream filter is the one stage of ffmpeg's pipeline that is neither an
// encoder nor a muxer: it works on packets that are already encoded, between
// the two. Which is why it is here and not on the Encode stage, and why it is
// per stream — `-bsf:v` and `-bsf:a` are different chains on different packets.
//
// **It is a list and it is drawn as one.** The order is the whole of the
// meaning: `h264_mp4toannexb,dump_extra` and the same two the other way round
// are different files. So it is a row per filter with the arrows to move one,
// closer to the graph's node list than to the option bags above it — which are
// unordered by nature and drawn as such.
//
// What can go on the list is asked of libavcodec and narrowed to the codec this
// stream is actually encoded with, out of each filter's own `codec_ids`. A
// filter that declares none runs on anything, which is a real answer and not an
// absence, so those are always offered.

function bsfsFor(codec) {
    const all = bro.ffmpeg.bitstreamFilters || [];
    if (!codec) return all;
    // The encoder's name is not the codec's — `libx264` encodes `h264` — and a
    // bsf's list is codec names. Asked of the encoder list rather than by
    // stripping a `lib` prefix, which would be a rule about spellings.
    const enc = (videoEncoders().concat(audioEncoders())).find((e) => e.id === codec);
    const name = (enc && enc.codecName) || codec;
    return all.filter((b) => !b.codecs.length || b.codecs.indexOf(name) >= 0);
}

function bsfRows(s, restate) {
    if (s.kind === 'attachment') return [];
    // Nor a data stream. A bitstream filter reworks a *codec's* packets —
    // every one of them declares which codecs it applies to — and a track
    // nothing decodes has none for a filter to be written against. The list
    // would come back empty, which reads as "none are installed" rather than
    // as "the question does not apply here".
    if (s.kind === 'data') return [];
    if (!s.bsf) s.bsf = [];

    const changed = () => { restate(); ctx.drawStreams(); };
    const choices = bsfsFor(ctx.codecOf(s));

    // No heading: the facet strip above already says this is the packet chain,
    // and a `.section-head` under it would be the same word twice.
    const rows = [];
    s.bsf.forEach((b, i) => {
        const pick = select({ cls: 'ex-bsf-name', 'data-f': `bsf-${i}`,
                              on: { change: (e) => { b.name = e.target.value;
                                                     b.options = {}; changed(); } } },
                            [{ id: '', label: 'pick one…' },
                             ...choices.map((c) => ({ id: c.name, label: c.name }))],
                            b.name || '');
        const move = (delta) => el('button', {
            cls: 'tiny', text: delta < 0 ? '↑' : '↓', 'data-bsf-move': `${i}:${delta}`,
            title: 'Move',
            on: { click: () => {
                const j = i + delta;
                if (j < 0 || j >= s.bsf.length) return;
                const tmp = s.bsf[i]; s.bsf[i] = s.bsf[j]; s.bsf[j] = tmp;
                changed();
            } },
        });
        rows.push(div('ex-bsf-row', [
            span(`${i + 1}`, 'ex-bsf-n dim'), pick, move(-1), move(1),
            el('button', { cls: 'tiny', text: '×', 'data-bsf-drop': String(i),
                           on: { click: () => { s.bsf.splice(i, 1); changed(); } } }),
        ]));
        if (!b.name) return;
        const all = bsfOptionsFor(b.name);
        if (!b.options) b.options = {};
        if (all.length)
            rows.push(...optionColumn({
                name: `bsfopts-${s.id}-${i}`,
                title: `${b.name} options · ${all.length}`,
                options: all,
                bag: b.options,
                hint: 'Anything set here is passed straight to the bitstream filter.',
                onChange: () => restate(),
            }));
    });

    rows.push(div('ex-add', el('button', {
        cls: 'tiny', text: '+ Bitstream filter', 'data-add': 'bsf',
        title: 'Add bitstream filter',
        on: { click: () => { s.bsf.push({ name: '', options: {} }); changed(); } },
    })));
    rows.push(div('ex-note dim',
        `${choices.length} of ${(bro.ffmpeg.bitstreamFilters || []).length} run on ` +
        `${ctx.codecOf(s) || 'this stream'}.`));
    return rows;
}

// Cached per filter, exactly as the encoder's and the muxer's tables are: the
// stream list is rebuilt on every keystroke in a language field.
const bsfOptionCache = new Map();

function bsfOptionsFor(name) {
    if (!bsfOptionCache.has(name)) {
        try {
            bsfOptionCache.set(name, bro.ffmpeg.bsfOptions(name) || []);
        } catch (e) {
            bsfOptionCache.set(name, []);
        }
    }
    return bsfOptionCache.get(name);
}

/// One toggle per disposition libavformat knows. Several at once, because a
/// stream can be forced *and* a commentary, and `+forced+comment` is exactly
/// what av_disposition_from_string is handed.
function dispositionToggles(s, restate) {
    const on = new Set((s.disposition || '').split(/[+, ]+/).filter(Boolean));
    const all = dispositions();
    return div('ex-flags', all.map((name) => el('button', {
        cls: 'tiny' + (on.has(name) ? ' on' : ''),
        text: name,
        'data-disp': name,
        on: { click: () => {
            if (on.has(name)) on.delete(name); else on.add(name);
            // Written the way ffmpeg's own `-disposition` argument is, so what
            // is stored is what would be typed.
            s.disposition = on.size ? '+' + Array.from(on).join('+') : '';
            restate();
            ctx.drawStreams();
        } },
    })));
}

/// The fourcc, offered as the muxer's own vocabulary rather than as four
/// characters nobody knows to type. hvc1 and hev1 are the same HEVC bitstream
/// and only the first plays on Apple hardware; a container that has nothing to
/// say about this codec shows no control at all rather than an empty menu.
function tagRow(s, restate) {
    if (s.kind !== 'video' && s.kind !== 'audio') return [];
    const tags = codecTags(settings.container, ctx.codecOf(s));
    if (!tags.length) return [];
    const choices = [{ id: '', label: `auto (${tags[0]})` }]
        .concat(tags.map((t) => ({ id: t, label: t })));
    return [row('Tag', [
        select({ 'data-f': 'stream-tag',
                 on: { change: (e) => { s.tag = e.target.value; restate(); } } },
               choices, s.tag || ''),
        span(`what ${settings.container} writes as the codec’s fourcc`, 'dim'),
    ])];
}

// ── key/value bags ─────────────────────────────────────────────────────────

/// A metadata dictionary, edited as pairs rather than as a line to be parsed.
///
/// `-metadata key=value` is two strings and a value is free to contain
/// anything, so a single field holding `a=b;c=d` would need an escaping rule
/// that would then be the only place in this application with one.
export function pairRows(bag, ns, changed) {
    const out = [];
    for (const k of Object.keys(bag)) out.push(pairRow(bag, ns, k, changed));
    out.push(pairRow(bag, ns, '', changed));
    return out;
}

function pairRow(bag, ns, key, changed) {
    const k = el('input', {
        cls: 'num', 'data-meta-key': `${ns}:${key}`, type: 'text', value: key,
        placeholder: 'key',
        on: { change: (e) => {
            const name = e.target.value.trim();
            const value = bag[key];
            delete bag[key];
            if (name) bag[name] = value === undefined ? '' : value;
            changed();
            ctx.drawStreams();
        } },
    });
    const v = el('input', {
        cls: 'wide', 'data-meta-val': `${ns}:${key}`, type: 'text',
        value: key ? String(bag[key]) : '',
        placeholder: key ? '' : 'value',
        on: { change: (e) => {
            const name = k.value.trim();
            if (!name) return;
            bag[name] = e.target.value;
            changed();
            if (!key) ctx.drawStreams();
        } },
    });
    return div('ex-pair', [k, v]);
}

// ── chapters ───────────────────────────────────────────────────────────────

/// Beside the streams, drawn as what they are: marks on the output timeline.
///
/// Deliberately not rows in the list above. A chapter has no index, nothing is
/// mapped to it, no player shows it in a track menu, and there is no
/// `-metadata:s:` for one — it is a table in the container. Drawn among the
/// streams it would invite the question "what is chapter 2's language", which
/// has no answer.
export function chapterRows() {
    const out = settings.chapters.map((c, i) => {
        const num = (key, cls) => el('input', {
            cls, 'data-ch': `${i}:${key}`, type: 'number', min: 0, step: 0.1,
            value: c[key],
            on: { change: (e) => { c[key] = Math.max(0, Number(e.target.value) || 0);
                                   ctx.restated(); } },
        });
        const title = el('input', {
            cls: 'wide', 'data-ch': `${i}:title`, type: 'text', value: c.title || '',
            placeholder: 'name',
            on: { change: (e) => { c.title = e.target.value; ctx.restated(); } },
        });
        return div('ex-chapter', [
            title, num('start', 'num'), span('→', 'dim'), num('end', 'num'),
            el('button', { cls: 'tiny', text: '×', 'data-ch-drop': String(i),
                           on: { click: () => { settings.chapters.splice(i, 1);
                                                ctx.changed(); } } }),
        ]);
    });
    out.push(div('ex-add', el('button', {
        cls: 'tiny', text: '+ Chapter', 'data-add': 'chapter',
        on: { click: () => {
            const last = settings.chapters[settings.chapters.length - 1];
            const from = last ? last.end : 0;
            settings.chapters.push({ start: from, end: from + 10, title: '' });
            ctx.changed();
        } },
    })));
    return out;
}
