// The Find stage, as one call for everything outside it.
//
// `ui/filtergraph.js` is the same idea over the filter graph and this is its
// twin: the stage holds a graph, a set of rules and an evaluation, and nothing
// else in the application should have to know that any of those are separate
// files. `ui/app.js` asks for a summary, `ui/document.js` asks for a snapshot,
// and the press that puts a stack on the timeline is here.
//
// **What this stage is for.** Sources answers "what is this file"; Compose
// answers "what is the edit". Between them there was nothing, and for a
// six-hour recording that gap is the entire job: the material has to be *found*
// before it can be arranged, and finding it means asking questions of the
// soundtrack — where was this word said, where did somebody talk for a while —
// and keeping the answers as stacks you can then weave together. That is a
// different question from either neighbour, which is why it is a stage and not
// a panel on one of them.
//
// **Where the reads live is deliberately not here.** A transcript and a set of
// marks belong to an *input* and are asked for on Sources, because they are a
// property of the file and cost minutes to hours of machine. This stage only
// ever *reads* them. That split is what keeps a rule cheap enough to re-evaluate
// on every keystroke, and it is why a finder wired to a recording nobody has
// listened to says which press is missing rather than starting one.

import { inputs, byId as inputById, lengthOf } from './inputs.js';
import { changed, makeClip, placeClip, project, sortClips } from './project.js';
import * as marksModel from './marks.js';
import * as transcriptModel from './transcript.js';
import { makeFindGraph, restoreFindGraph, evaluate, stacksOf, useNodeId } from './find/model.js';
import * as S from './find/stack.js';

let graph = makeFindGraph();

/// The last evaluation, and what it was of.
///
/// **Memoised against three things and not against a timer**, because all three
/// genuinely change the answer and nothing else does: the graph itself
/// (`graph.rev`), what has been transcribed, and what has been listened to. The
/// last two arrive on the model's change channel while a six-hour read is
/// running, so the stamp is bumped there rather than compared — comparing would
/// mean walking every transcript on every frame to find out whether to walk it.
let cached = null;
let cachedKey = '';
let readStamp = 0;

/// Something a rule reads has landed. Called from the one place the transcript
/// and marks channels are drained, for `ui/marks.js` `retain()`'s reason: there
/// is more than one way for a read to change and the one that gets missed is the
/// one that leaves a stack showing yesterday's answer.
export function readsMoved() { readStamp++; }

export function findGraph() { return graph; }

/// The world a rule is evaluated against.
///
/// Four functions, and they are the *whole* of what makes a stack depend on
/// anything outside the graph — which is what lets `tests/ui_find.js` evaluate a
/// real graph against a transcript that was never read from a file. See
/// `evaluate` in `ui/find/model.js`.
export function context() {
    return {
        inputById: (id) => inputById(id),
        durationOf: (id) => {
            const i = inputById(id);
            return i ? lengthOf(i) : 0;
        },
        search: (id, phrase, whole) => transcriptModel.searchIn(id, phrase, whole),
        coverageOf: (id) => transcriptModel.coverageOf(id),
        marksOf: (id) => marksModel.marksOf(id),
    };
}

/// Run the rules, or hand back the run that is still current.
export function result() {
    const key = `${graph.rev}:${readStamp}`;
    if (cached && cachedKey === key) return cached;
    cached = evaluate(graph, context());
    cachedKey = key;
    return cached;
}

/// Run the rules against a world somebody else supplies, and do not cache it.
///
/// **The seam that makes this stage checkable at all**, and it is a seam rather
/// than a test hook: `evaluate` was given its world as four functions precisely
/// so that the answer could be asked of something other than the machine's
/// state, and this is that argument taken. A suite hands over a transcript that
/// was never read from a file and asserts what a 1:3 weave does; the alternative
/// is a suite that has to transcribe six hours to find out.
///
/// Uncached on purpose. The memo above is keyed on what the *application* has
/// read, and a run against a made-up world has nothing to do with that — writing
/// one into the cache would leave the screen showing somebody else's answer.
export function evaluateWith(ctx) { return evaluate(graph, ctx); }

/// Every named stack the graph ends in, with what it holds.
export function stacks() { return stacksOf(graph, result()); }

/// What the spine's card says: how many stacks, and how much material.
///
/// Two short lines, `ui/shell.js`'s shape. It says the *totals* rather than the
/// stack count alone because a stage whose card read "3 stacks" for an hour
/// while a transcript filled in behind it would be a card that never moved —
/// and the whole difficulty this stage addresses is a read that takes an hour.
export function findSummary() {
    const list = stacks();
    if (!graph.nodes.length) return ['empty', ''];
    if (!list.length) return [`${graph.nodes.length} rules`, 'no stacks yet'];
    let n = 0, secs = 0;
    for (const s of list) { n += s.list.length; secs += S.totalOf(s.list); }
    return [`${list.length} stack${list.length === 1 ? '' : 's'}`,
            n ? `${n} clips · ${S.showTime(secs)}` : 'nothing found yet'];
}

// ── a stack becomes an edit ───────────────────────────────────────────────

/// Put a stack on the timeline, end to end, on one track.
///
/// **The one press in this application that turns a search into work**, and the
/// place every caution about the two clocks finally cashes out. A candidate off
/// a `Said` carries the ten seconds either side that `ui/transcript.js`
/// measured between a VOD's renditions, so what lands is a span that *contains*
/// the moment rather than a cut at it — the trimming is a human's, on the
/// timeline, with the picture in front of them. Nothing here claims a frame.
///
/// **End to end and on one track**, rather than at each candidate's own time.
/// A stack is an *order*, which is what every arrangement node produces and what
/// `Mix` and `Every` exist to decide; laying it out at source times would throw
/// that order away and put twelve hundred clips at the same place besides.
///
/// Appended after whatever is there rather than replacing it, because sending a
/// second stack is the ordinary use — that is what building a montage out of
/// several rules *is* — and a press that silently cleared the timeline would
/// destroy the first one.
///
/// Returns what happened, so the caller can say it. `skipped` is candidates
/// whose input has gone away since the rule ran, which is possible: an input can
/// be removed on Sources while a stack naming it sits on this canvas.
export function sendToTimeline(list, track = 0) {
    const made = [];
    let skipped = 0;
    // Where this stack starts: after everything already on that track, so two
    // stacks sent in turn read as two runs rather than as one interleaved mess.
    let at = 0;
    for (const c of project.clips)
        if (c.track === track) at = Math.max(at, c.start + c.length);

    for (const cand of list) {
        const input = inputById(cand.inputId);
        if (!input || !input.probe) { skipped++; continue; }
        const clip = makeClip(input);
        clip.track = track;
        clip.inPoint = cand.in;
        // `length` is the *timeline* length and the source span is
        // `length * speed` — `ui/project.js` says so at the field, and speed is
        // 1 on a fresh clip, so these are the same number here. Written through
        // the field that means what is wanted rather than assuming they stay
        // equal, because a later hand setting a speed on the way in would
        // otherwise silently change what span was taken.
        clip.length = Math.max(0.04, S.lengthOf(cand) / (clip.speed || 1));
        clip.start = at;
        // The reason it is here, carried onto the clip. A timeline of forty
        // clips all called `twitch-vod-2834479749.mkv` is a timeline nobody can
        // read; `1:04:12 · "oh yeah that's the"` is one you can work in. This is
        // what `why` on a candidate was for.
        clip.name = `${S.showAt(cand.at)} ${cand.detail || cand.rule}`.trim();
        at += clip.length;
        // **`placeClip` and not `addClip`.** `addClip` has an opinion about
        // where a clip goes — the end of its track, or the top for a batch —
        // because dropping a file is an act with one, and it writes `start`
        // whichever way it is asked. A stack is an *arrangement*: the order is
        // what `Mix` and `Every` were for, and letting each clip be re-placed
        // would stack all of them at one point and throw that order away. This
        // is `ui/document.js`'s case exactly, which is the function's own
        // stated reason for existing.
        placeClip(clip);
        made.push(clip);
    }
    if (made.length) {
        sortClips();
        // The canvas, when there is not one yet. `addClip` seeds it from the
        // first clip and `placeClip` deliberately does not — a document brings
        // its own — so a stack sent into an empty project has to say. Only when
        // it is unset: a stack sent into an edit that already has a size must
        // not resize it.
        if (!project.width && made[0].width) {
            project.width = made[0].width;
            project.height = made[0].height;
            project.fps = made[0].fps;
        }
        changed('clips');
    }
    return { made: made.length, skipped };
}

// ── the document ──────────────────────────────────────────────────────────

/// The rules, for `ui/document.js` `snapshot()`.
///
/// **In the document, unlike a transcript.** A rule is authored — "for every one
/// of these, three of those" is somebody's editorial decision — where a
/// transcript is derived and would be the same on a second read. See the top of
/// `ui/find/model.js`. So this is in a `.fbro`, on the undo track and in the
/// unsaved marker; the stacks it computes are in none of them, because they come
/// back from the rules the way a waveform comes back from a file.
export function snapshot() { return graph.toJSON(); }

/// Put one back. `ui/document.js` `open()`'s contract: whatever is under the key
/// was written by an earlier version of this code, so `restoreFindGraph` skips
/// what it does not recognise rather than refusing the document.
export function open(json) {
    graph = restoreFindGraph(json);
    graph.onChange(onGraphChange);
    cached = null;
    cachedKey = '';
    changed('find');
}

// `New` needs no call of its own: `ui/document.js` `reset()` is an `open()` of
// an empty document, so it arrives here as `open(null)` and this graph is
// replaced with an empty one by the same path an opened file takes. A second
// entry point would be a second thing to remember to keep in step.

function onGraphChange() { changed('find'); }
graph.onChange(onGraphChange);

/// Drop rules pointing at inputs that are not here any more.
///
/// **A `source` is repointed to nothing rather than removed**, and that is the
/// difference between this and `ui/marks.js` `retain()`. A set of marks for a
/// vanished input is dead weight; a *rule* is work — a phrase somebody typed, a
/// mix they tuned, wired into five other nodes — and deleting the source node
/// would take the wires with it and leave the graph in pieces because a file was
/// removed on another stage. So the node stays, says it has no recording, and
/// answers with an empty stack until something is wired back in.
export function retain(inputIds) {
    const keep = new Set(inputIds);
    let moved = false;
    for (const n of graph.nodes) {
        if (n.kind !== 'source') continue;
        if (!n.params.inputId || keep.has(n.params.inputId)) continue;
        graph.setParam(n, 'inputId', '');
        moved = true;
    }
    if (moved) changed('find');
}

/// Every input that could be wired in, for the source node's picker.
export function pickableInputs() { return inputs.filter((i) => !!i.probe); }

export { useNodeId };
