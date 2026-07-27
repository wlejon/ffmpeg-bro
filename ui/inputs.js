// The `-i`s.
//
// An input did not exist as a thing until now. A clip carried a path, the
// Sources stage derived a list of files by walking the timeline for distinct
// paths, and every open in the native half was handed no format and no options.
// Three consequences, and each of them is a thing ffmpeg does that this
// application could not: a demuxer could not be forced, `-probesize` could not
// be set when a file probed wrong, and a source could not be a URL although
// this build links openssl and srt and reports thirty-six input protocols.
//
// So an input is first class, and a clip **references** one. What lives here is
// everything that appears *before* `-i` on a command line — which is not a fact
// about argument order but about when a decision is taken: the demuxer, its
// options and the window are settled while the file is being opened, and none
// of them can be changed afterwards.
//
// Two rules are load-bearing:
//
//   - **An input with no clip is an ordinary state.** Opening a file to look at
//     what is in it is a thing people do, and this list is not garbage
//     collected against the timeline. `Use on the timeline` is an action, not
//     an automatic consequence of adding one.
//   - **An input seek is not a clip's in-point.** `-ss` decides what the input
//     *is*: its zero moves, its reported duration shrinks, and a clip cut from
//     it is measured from there. Trimming a clip picks a moment out of an
//     input; this decides which input there is to pick from.
//
// The probe is kept here rather than on the clip because it is the input's
// answer: run the file through a different demuxer or a different `-probesize`
// and it says something else, which is exactly what the Sources stage is for.

import { basename } from './format.js';
import { changed } from './project.js';

/// Every input, in the order they were added. **The index is the `-i` number**
/// a render's spec and a filtergraph's `[0:v]` both count in, so nothing may
/// reorder this list under a spec that has been built from it.
export const inputs = [];

let nextId = 1;

/// One input as the native side wants it: `probe()`, `inputs.define()` and
/// `spec.inputs` all take this shape, so the thing the Sources stage probes and
/// the thing the render opens cannot come to be described differently.
///
/// `to` is carried as an end time and `t` is not carried at all. They are one
/// decision — where the input stops — and holding both would be holding two
/// fields that can disagree; the native side converts, because "a window that
/// ends before it starts is empty" is a rule with one right answer.
export function asInput(i) {
    return {
        path: i.path,
        format: i.format || '',
        options: i.options || {},
        ss: i.ss || 0,
        to: i.to || 0,
        itsoffset: i.itsoffset || 0,
        streamLoop: i.streamLoop || 0,
    };
}

/// Everything about an input that changes what opening it produces.
///
/// Used to decide whether a re-probe is needed and whether the clips reading it
/// have to be reloaded. The name and the id are deliberately not in it: a
/// rename is not a reopen.
function openingKey(i) {
    return JSON.stringify(asInput(i));
}

/// Add one. Probed and registered immediately — `probe()` is in-process, so the
/// answer is here before anything has to be laid out, and the registration is
/// what lets a `<video>` play it.
export function addInput(spec) {
    const input = {
        id: `in${nextId++}`,
        path: String(spec.path || '').trim(),
        format: spec.format || '',
        options: Object.assign({}, spec.options),
        ss: spec.ss || 0,
        to: spec.to || 0,
        itsoffset: spec.itsoffset || 0,
        streamLoop: spec.streamLoop || 0,
        // What the scan found, when this input came out of one: the numbers
        // that are on disk. Kept because it is the answer to "and where does
        // it start" and "how many are there", which nothing else can say —
        // `probe()` reports what image2 read, and image2 stops at the first
        // gap, so the two are different facts and both are worth showing.
        sequence: spec.sequence || null,
        // The files a `concat` list was written out of, for the same reason:
        // the list is a file on disk and the input is the list, so without
        // this nothing on screen could say what is being joined.
        parts: spec.parts || null,
        probe: null,
        error: '',
        src: '',
        key: '',
    };
    input.name = basename(input.path) || input.path;
    inputs.push(input);
    reopen(input);
    return input;
}

/// Change one, and put back everything that follows from the change.
///
/// Returns true when the change was one that reopens the file — a new demuxer,
/// a new option, a new window — because the clips reading it then have a
/// different input under them and the caller has to reload them. A change that
/// does not (there are none yet, and there will be: a name) costs nothing.
export function updateInput(input, patch) {
    const before = input.key;
    Object.assign(input, patch);
    if (patch && patch.options) input.options = Object.assign({}, patch.options);
    input.name = basename(input.path) || input.path;
    if (openingKey(input) === before) return false;
    reopen(input);
    return true;
}

/// Probe with the options in force, and register the result for playback.
///
/// **The probe is the answer to "what did the options I just set do".** A
/// Sources stage that showed what libavformat's defaults made of a file while
/// the render opened it with `-f` and a `-probesize` would be describing a
/// different file from the one about to be rendered, which is the whole failure
/// this stage exists to prevent.
function reopen(input) {
    input.key = openingKey(input);
    input.error = '';
    input.probe = null;
    if (!input.path) { input.error = 'no path or URL'; return; }
    try {
        input.probe = bro.ffmpeg.probe(asInput(input));
    } catch (e) {
        input.error = String((e && e.message) || e);
    }
    // Registered even when the probe failed: the token is stable, and a `<video>`
    // pointed at a broken input should fail as that input rather than as a
    // string nothing recognises.
    try {
        input.src = bro.ffmpeg.inputs.define(input.id, asInput(input));
    } catch (e) {
        input.error = input.error || String((e && e.message) || e);
    }
}

/// Open it again with exactly what it says now — the button beside a URL that
/// was not reachable a minute ago, and the way a change to the option bag
/// (which is edited in place) is committed.
export function reprobe(input) {
    reopen(input);
}

/// Take one out. The caller is responsible for the clips: an input that
/// something on the timeline is cut from is not removable, because a clip with
/// no input is a clip with nothing to decode.
export function removeInput(input) {
    const i = inputs.indexOf(input);
    if (i < 0) return false;
    inputs.splice(i, 1);
    try { bro.ffmpeg.inputs.forget(input.id); } catch (e) { /* already gone */ }
    changed('inputs');
    return true;
}

/// Where this input sits in the list, which is the number `-i` gives it.
export function indexOf(input) { return inputs.indexOf(input); }

export function byId(id) { return inputs.find((i) => i.id === id) || null; }

/// An existing input on this path that nothing has been said about, or null.
///
/// What "open a file" means when the file is already open: dropping the same
/// file twice is two clips of one input, exactly as ffmpeg would open it once.
/// An input carrying a forced demuxer or an option bag is *not* a match — it is
/// a decision somebody took, and a second drop must not silently inherit it.
export function plainInputFor(path) {
    return inputs.find((i) => i.path === path && !i.format && !i.ss && !i.to &&
                              !i.itsoffset && !Object.keys(i.options).length) || null;
}

/// How long this input is, on its own clock. Zero when it could not be read.
export function lengthOf(input) {
    const p = input.probe;
    if (!p) return 0;
    return (p.video && p.video.duration) || p.format.duration || 0;
}

/// What this input is set to, in one line, for a card and for the spine.
export function summary(input) {
    const bits = [];
    if (input.streamLoop) bits.push(`-stream_loop ${input.streamLoop}`);
    if (input.format) bits.push(`-f ${input.format}`);
    for (const k of Object.keys(input.options)) bits.push(`-${k} ${input.options[k]}`);
    if (input.ss) bits.push(`-ss ${input.ss}`);
    if (input.to) bits.push(`-to ${input.to}`);
    if (input.itsoffset) bits.push(`-itsoffset ${input.itsoffset}`);
    return bits.join(' ');
}

/// What this input's content *is*: one file, a numbered run of them, a single
/// picture held for a chosen length, or a list read end to end.
///
/// Derived and never stored. Every one of those is a consequence of the path,
/// the demuxer and the option bag — a sequence is a path with `%04d` in it, a
/// still is an image file that is not one — so a `kind` field would be a
/// second place for the same fact to live and the two would drift.
export function kindOf(input) {
    // A device first, because it is the one kind that is not read off the path
    // at all: `-f gdigrab -i desktop` is a device and `-i desktop` is a file
    // that is not there. The demuxer is what says which, and the list of
    // devices is libavdevice's own.
    if (isDeviceFormat(input.format)) return 'device';
    if (input.format === 'concat') return 'concat';
    if (bro.ffmpeg.hasFramePattern(input.path)) return 'sequence';
    if ((input.options.pattern_type || '') === 'glob') return 'sequence';
    if (isImagePath(input.path)) return 'still';
    return 'file';
}

/// True when this input goes on producing pictures for as long as it is asked
/// to, so that nothing about it says how long it is.
///
/// The same rule the native side applies (`inputIsEndless` in
/// src/native/ffmpeg_input.h), and it has to stay the same rule: it is what
/// decides whether `-t` is the whole of the answer, and a UI that disagreed
/// with the renderer about that would lay out a clip at a length the render
/// does not produce.
export function endless(input) {
    if (input.streamLoop) return true;
    // A device does not end — a camera, a screen grabber and a sound card go
    // on producing for as long as they are asked to. Same rule as the native
    // `inputIsEndless`, which asks libavdevice the same question.
    if (isDeviceFormat(input.format)) return true;
    const loop = input.options.loop;
    return loop !== undefined && loop !== '' && String(loop) !== '0';
}

/// Does this `-f` name one of libavdevice's input devices?
///
/// Against `bro.ffmpeg.devices`, which is the registry walk, so a build with
/// more of them needs no edit here — and so this cannot disagree with the
/// native side, which asks the same registry.
export function isDeviceFormat(format) {
    if (!format) return false;
    return (bro.ffmpeg.devices || []).some(
        (d) => d.direction === 'input' && d.name === format);
}

/// Does this path name a still picture? The extensions are libavformat's own
/// — the image2 muxer's list plus every `*_pipe` demuxer — so there is no
/// table of image formats written down here either.
export function isImagePath(path) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ''));
    if (!m) return false;
    return (bro.ffmpeg.imageExtensions || []).indexOf(m[1].toLowerCase()) >= 0;
}

/// The scheme a URL names, or '' for a plain path. `file` is left as '' too:
/// the protocol column is about the ones somebody chose.
export function schemeOf(path) {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(String(path || ''));
    if (!m) return '';
    return m[1].toLowerCase() === 'file' ? '' : m[1].toLowerCase();
}

/// Everything the render has to be told about the inputs, in spec order.
export function specInputs() {
    return inputs.map(asInput);
}
