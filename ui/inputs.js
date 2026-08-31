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
//
// **A URL and a device are opened off this thread, and a path is not.**
// `probe()` is in-process and synchronous, which is right for the
// overwhelmingly common case — a file on disk answers in a few hundred
// microseconds and every caller wants the answer before it can lay anything
// out. It is wrong for the two kinds of input whose open is not this
// application's to make fast: a URL that waits four seconds for a handshake,
// and a device that is another application's, or mid-reset, or simply slow —
// `dshow` opening a *working* audio device measures 920 ms here. Both wait on
// *this* thread, and this thread is the whole application, because stage views
// are never unmounted and the viewer's `<video>` elements are the decoders. So
// both go through `bro.ffmpeg.probes.start` and are watched from the frame
// loop; anything else takes the call it always took and costs exactly what it
// always cost.
//
// **What decides is a lookup that opens nothing.** `schemeOf` reads the first
// characters of the path and `isDeviceFormat` looks the `-f` up in the device
// registry already in memory — neither opens anything, neither asks libav a
// question that can wait on hardware, and so the thing that chooses cannot
// itself block, which was the other way of getting this wrong. A `file:` URL
// comes back as no scheme, because that is the long way of writing a path.
//
// **The two waits are not the same wait, and the difference is on screen.**
// libav's interrupt callback aborts a URL's open wherever it has got to; it is
// never consulted during a device's `read_header` at all, so a Stop there ends
// the *waiting* and leaves the thread inside libav until the driver answers.
// `probes.poll().stoppable` is which one this is, and `stopOpening` below acts
// on it rather than pretending they are one thing.

import { basename, urlScheme } from './format.js';
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
        // The decoders reading this input, as against the demuxer opening it.
        // A separate bag because they are separate objects with separate option
        // tables — `-probesize` is libavformat's and `-skip_frame` is
        // libavcodec's — and ffmpeg writes both in front of the same `-i`
        // because both are decisions about this input.
        decoderOptions: i.decoderOptions || {},
        // The device this input's pictures are decoded on, and whether they
        // come back down. Three more things that go in front of the `-i`,
        // because all three configure the decoder this input's packets go
        // through — and because two clips cut from one file cannot be decoded
        // one way and the other.
        hwaccel: i.hwaccel || '',
        hwaccelDevice: i.hwaccelDevice || '',
        hwaccelOutputFormat: i.hwaccelOutputFormat || '',
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

/// Note that an id has been handed out, so the counter never issues it again.
///
/// An input's id is written down outside this file — the graph overlay's source
/// nodes name one, and so does every clip in a document — so restoring one has
/// to keep the id rather than renumber and silently re-point a node at a
/// different file. Told rather than set, for the reason `useClipId` in
/// ui/project.js is: something may already have taken a number from this counter
/// before the document arrives.
export function useInputId(id) {
    const m = /^in(\d+)$/.exec(String(id || ''));
    if (m && Number(m[1]) >= nextId) nextId = Number(m[1]) + 1;
}

/// Add one. Probed and registered immediately — `probe()` is in-process, so the
/// answer is here before anything has to be laid out, and the registration is
/// what lets a `<video>` play it.
///
/// **`spec.id` is honoured when it is free**, which is how a document puts its
/// inputs back under the nodes and clips that name them. Ignored when something
/// already has it, because two inputs `byId` cannot tell apart is worse than a
/// node that has lost its file: every clip of the second would be laid out
/// against the first.
export function addInput(spec) {
    const wanted = String((spec && spec.id) || '');
    const id = wanted && !byId(wanted) ? wanted : `in${nextId++}`;
    useInputId(id);
    const input = {
        id,
        path: String(spec.path || '').trim(),
        format: spec.format || '',
        options: Object.assign({}, spec.options),
        decoderOptions: Object.assign({}, spec.decoderOptions),
        hwaccel: spec.hwaccel || '',
        hwaccelDevice: spec.hwaccelDevice || '',
        hwaccelOutputFormat: spec.hwaccelOutputFormat || '',
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
        // The open in flight, when there is one: `{ id, elapsed, timeout }`.
        // Null the rest of the time, which is every input on a path — see
        // `reopen`. Nothing outside this file may write it; `tickInputs` is
        // what clears it, and it clears it by *settling* the input.
        opening: null,
        // The files a `concat` list was written out of, for the same reason:
        // the list is a file on disk and the input is the list, so without
        // this nothing on screen could say what is being joined.
        parts: spec.parts || null,
        probe: null,
        error: '',
        src: '',
        key: '',
        // Set by `reopen` below, before anything can ask. Declared here so the
        // shape of an input is one list and not two.
        remote: false,
    };
    // **A name the caller gave, where there is one.** Every input on a path is
    // named by its basename and that is right; a stream URL is the case where
    // it is not, because what `basename` has to work with can be
    // `index-dvr.m3u8?sig=…&token=…` — five hundred characters of signature
    // naming a stream nobody typed.
    input.name = String((spec && spec.name) || '') ||
                 basename(input.path) || input.path;
    // Where a resolved input came *from*, when it was resolved rather than
    // typed. Kept because a signed stream URL expires and the page it named
    // does not, so this is the half worth writing into a document.
    input.origin = String((spec && spec.origin) || '');
    // The other streams of the same recording, where a resolver named several —
    // `[{ name, url, bandwidth, audioOnly }]`, best first. Dormant since the
    // page resolver (`ui/vod.js`) left the UI with the ffmpeg-only pass:
    // nothing supplies them now, and the fields stay because the resolver is
    // expected back. Held in memory and never in a document — the URLs are
    // signed and expire, which is what `origin` above is for.
    input.renditions = Array.isArray(spec && spec.renditions) ? spec.renditions : null;
    input.rendition = String((spec && spec.rendition) || '');
    // Where the local copies of this stream were written, once they have been.
    // See `ui/localcopy.js`. `localAudio` is the dormant half of the same pair:
    // it named the audio-only rendition's copy, which nothing pulls now.
    input.localCopy = '';
    input.localAudio = '';
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
    if (patch && patch.decoderOptions)
        input.decoderOptions = Object.assign({}, patch.decoderOptions);
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
    // **Is this input read over a link?** Decided here, where the scheme is
    // already being parsed, and read from here by everything that has to price
    // a read of it — `ui/analysis.js` reads a remote input for the span on
    // screen rather than whole. `schemeOf` answers '' for `file:`, which has a
    // scheme and is a file on this machine; that distinction is the whole
    // reason this is not a regex at each caller.
    input.remote = !!schemeOf(input.path);
    // Whatever was already in flight is answering about the input this one no
    // longer is, and nobody is going to be told: forgotten rather than
    // cancelled, so the thread is reaped and no stale answer can land on top of
    // the new one.
    dropOpening(input);
    if (!input.path) { input.error = 'no path or URL'; return; }
    // Registered even when the probe failed or has not finished: the token is
    // stable, and a `<video>` pointed at a broken input should fail as that
    // input rather than as a string nothing recognises. First, too, because a
    // URL's answer is minutes of network away and the token must exist before
    // anything asks for it.
    try {
        input.src = bro.ffmpeg.inputs.define(input.id, asInput(input));
    } catch (e) {
        input.error = String((e && e.message) || e);
    }
    if (schemeOf(input.path) || isDeviceFormat(input.format)) {
        // No timeout named, so the native side's own applies — one number, in
        // one place (`kProbeTimeoutSec`), rather than a second one here that
        // could disagree with the deadline actually being measured.
        //
        // **`stoppable` is seeded rather than left optimistic**, because the
        // card is drawn in the same turn this runs and a button that read
        // `Stop` for one frame and `Stop waiting` for the next would be a
        // flicker between a lie and the truth. The seed is the same registry
        // walk the native side makes — `isDeviceFormat` below says why the two
        // cannot disagree — and the first poll replaces it with the answer the
        // open itself carries, which stays the authority.
        try {
            input.opening = { id: bro.ffmpeg.probes.start(asInput(input)),
                              elapsed: 0, timeout: 0,
                              stoppable: !isDeviceFormat(input.format) };
        } catch (e) {
            input.error = input.error || String((e && e.message) || e);
        }
        return;
    }
    try {
        input.probe = bro.ffmpeg.probe(asInput(input));
    } catch (e) {
        input.error = input.error || String((e && e.message) || e);
    }
}

/// Cancel an open nobody is waiting for any more, and forget it.
function dropOpening(input) {
    if (!input.opening) return;
    try { bro.ffmpeg.probes.forget(input.opening.id); } catch (e) { /* already gone */ }
    input.opening = null;
}

/// Is this input still waiting on something this application does not control —
/// a host at the far end of a socket, or a driver?
export function opening(input) { return !!(input && input.opening); }

/// Would `stopOpening` reach the open itself, or only the waiting?
///
/// The native side's answer, carried rather than re-derived: whoever draws the
/// button and whoever presses it must be reading one fact, and "is this a
/// device" is only the same question by measurement. False for an input that is
/// not opening at all, because there is nothing there to reach.
export function openStoppable(input) {
    return !!(input && input.opening && input.opening.stoppable !== false);
}

/// Give up on the open in flight. The press behind `Stop`.
///
/// **Two presses, because there are two waits**, and collapsing them would make
/// the button claim something it cannot do on one of them.
///
/// On a URL it reaches the open: `cancel` sets the `AVIOInterruptCB` the native
/// side installed before the first byte was read, and libav abandons the
/// connect, the handshake or the read it is inside. The answer arrives through
/// `tickInputs`, saying `stopped`, so the press is visibly what ended it.
///
/// On a device it cannot — libavdevice's `read_header` never polls that
/// callback (measured: zero polls across a 400 ms `dshow` open) — so what the
/// press ends is the *waiting*. `forget` abandons the entry, the thread is
/// reaped whenever libav lets it go, and the input settles **now**, saying so
/// in its own words. `cancel` here would leave the card reading "Opening" until
/// the driver answered, which is exactly the state the press was meant to end.
///
/// Returns true when there was something to stop.
export function stopOpening(input) {
    if (!input || !input.opening) return false;
    if (input.opening.stoppable !== false) {
        try { bro.ffmpeg.probes.cancel(input.opening.id); } catch (e) { /* already gone */ }
        return true;
    }
    dropOpening(input);
    // Not "will not open": nobody has learned that it will not. What is known
    // is that nobody is waiting any more, and `Re-probe` is how to wait again.
    input.error = 'stopped waiting — the device had not answered';
    changed('inputs');
    return true;
}

/// Take in whatever the opens in flight have to say. Called once a frame.
///
/// Returns true when at least one input **settled** — got its probe, its
/// refusal or its stop — which is a redraw. It deliberately does not return
/// true merely because a clock moved: a card that redrew sixty times a second
/// for four seconds to move one number would relay out every panel on the
/// stage. The elapsed seconds are on `input.opening` for whoever wants to draw
/// them, and the Sources stage writes that one text node itself.
export function tickInputs() {
    let settled = false;
    for (const input of inputs) {
        if (!input.opening) continue;
        let p = null;
        try { p = bro.ffmpeg.probes.poll(input.opening.id); } catch (e) { p = null; }
        // Nothing knows the id: the answer was taken already, or the process
        // lost it. Either way this input is not opening any more, and leaving
        // it that way would be a card that says "connecting" for ever.
        if (!p) {
            input.opening = null;
            input.error = input.error || 'the open went away before it answered';
            settled = true;
            continue;
        }
        if (p.opening) {
            input.opening.elapsed = p.elapsed;
            input.opening.timeout = p.timeout;
            input.opening.stoppable = p.stoppable !== false;
            continue;
        }
        input.opening = null;
        settled = true;
        if (p.state === 'done') input.probe = p.result;
        else input.error = p.error || (p.state === 'stopped' ? 'stopped' : 'will not open');
    }
    if (settled) changed('inputs');
    return settled;
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
    dropOpening(input);
    try { bro.ffmpeg.inputs.forget(input.id); } catch (e) { /* already gone */ }
    changed('inputs');
    return true;
}

/// Put the list into a given order, by id.
///
/// **The one thing allowed to reorder it**, and the exception is narrow enough
/// to state: the order *is* the `-i` number, so nothing may reorder this list
/// under a spec built from it — but a document is not built from it, it is what
/// the list is being made to agree with. Opening one reconciles rather than
/// rebuilds (see ui/document.js), so an input the document lists second and this
/// run happens to hold first would otherwise come back as a different `-i` from
/// the one the document's own graph was written against.
///
/// Ids the list does not have are ignored and inputs the order does not name
/// keep their relative places at the end, so a partial answer cannot lose one.
export function orderInputs(ids) {
    const rank = new Map();
    (ids || []).forEach((id, i) => { if (!rank.has(String(id))) rank.set(String(id), i); });
    const at = (input) => (rank.has(input.id) ? rank.get(input.id) : rank.size + inputs.indexOf(input));
    const sorted = inputs.slice().sort((a, b) => at(a) - at(b));
    if (sorted.every((input, i) => inputs[i] === input)) return false;
    inputs.length = 0;
    for (const input of sorted) inputs.push(input);
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
                              !i.itsoffset && !i.hwaccel &&
                              !Object.keys(i.options).length &&
                              !Object.keys(i.decoderOptions || {}).length) || null;
}

/// How long this input is, on its own clock. Zero when it could not be read.
///
/// The video stream's own duration comes first because they differ: an audio
/// track routinely runs a fraction of a second past the last picture, and it is
/// the pictures a clip's length is measured in. `ui/project.js` says the same
/// thing a second time, in `mediaLength()`, and says there why — this module
/// imports `changed` from that one, so the import cannot go the other way.
export function lengthOf(input) {
    const p = input.probe;
    if (!p) return 0;
    return (p.video && p.video.duration) || p.format.duration || 0;
}

/// Which kinds of stream this input turned out to carry — `['v']`, `['v','a']`,
/// `['a']`, `['v','a','s']`.
///
/// One implementation, because three things ask: the spec's `inputInfo` (which
/// decides how many sockets a source card on the Graph stage draws), the graph
/// palette (which offers an input only for a pad it can fill), and anything
/// after them. An unprobed input answers `['v']` rather than nothing — a file
/// that has not been read yet is not a file with no picture in it.
///
/// **`s` is a pad only for a subtitle track made of pictures**, and that is the
/// load-bearing part of this function rather than a detail of it. A graph draws
/// cues by painting the bitmaps a `dvdsub` or `hdmv_pgs_subtitle` track carries
/// — which is what ffmpeg's own sub2video does and what `export_sub2video.h`
/// does here — and there is nothing to paint out of a *text* track: drawing
/// characters is libass's job, which is the `subtitles` filter and lives on the
/// Sources card and the clip panel as `Burn in`. So a `.srt` grows no socket,
/// because there is nothing anybody could do with one, and a spec that arrives
/// carrying such a pad anyway is refused by name in the render. `textSub` is
/// libavcodec's own `AV_CODEC_PROP_TEXT_SUB`, reported per stream by `probe()`.
export function streamKinds(input) {
    const p = input && input.probe;
    if (!p) return ['v'];
    const out = [];
    for (const s of p.streams) {
        const kind = s.kind === 'audio' ? 'a' : s.kind === 'video' ? 'v'
                   : (s.kind === 'subtitle' && s.textSub === false) ? 's' : '';
        if (kind && out.indexOf(kind) < 0) out.push(kind);
    }
    return out.length ? out : ['v'];
}

/// Is there a soundtrack in this input for anything to read?
///
/// The one-word form of `streamKinds`, because it is asked as a yes or no in
/// several places and `indexOf('a') >= 0` written out at each of them is the
/// shape a disagreement grows in. **This is not the same question as whether a
/// clip is muted**: a muted clip has sound and is not being listened to, and a
/// video-only file has none to listen to — and only the first was ever asked,
/// which is how the Write stage came to offer "the mix, through aac" for a
/// timeline with nothing to mix.
export function hasSound(input) {
    return streamKinds(input).indexOf('a') >= 0;
}

/// What this input is set to, in one line, for a card and for the spine.
export function summary(input) {
    const bits = [];
    if (input.streamLoop) bits.push(`-stream_loop ${input.streamLoop}`);
    if (input.format) bits.push(`-f ${input.format}`);
    if (input.hwaccel) bits.push(`-hwaccel ${input.hwaccel}`);
    if (input.hwaccelDevice) bits.push(`-hwaccel_device ${input.hwaccelDevice}`);
    if (input.hwaccelOutputFormat)
        bits.push(`-hwaccel_output_format ${input.hwaccelOutputFormat}`);
    for (const k of Object.keys(input.options)) bits.push(`-${k} ${input.options[k]}`);
    for (const k of Object.keys(input.decoderOptions || {}))
        bits.push(`-${k} ${input.decoderOptions[k]}`);
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
///
/// **The other `kindOf` is not a variant of this one.**
/// `ui/export/destination.js` has a function of the same name answering *what
/// shape the output is* — one file, a set, a stream, several at once — which
/// is a different question about a different end of the render. Nothing
/// imports both, and the one sub-fact they share is `hasFramePattern`: here a
/// `pattern_type=glob` bag is a sequence as well, because that is the other
/// way of naming a run to the `image2` demuxer, and there is no writing-end
/// equivalent for the destination's copy to be missing.
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
    // A file of cues, which is an `-i` with nothing to lay out: no picture, no
    // sound, and libavformat reports no duration for one because a subtitle
    // stream's length is where its last cue ends rather than anything in a
    // header. Read off the probe rather than the extension — an `.srt` is not
    // the only shape one comes in and this is the answer libavformat gave.
    if (input.probe && input.probe.streams.length &&
        input.probe.streams.every((s) => s.kind === 'subtitle'))
        return 'subtitles';
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

/// Every extension a demuxer in this build claims, lower case, as a Set.
///
/// **Asked, not written down**, which is the convention — but it is here rather
/// than beside either caller because there are two of them and they would
/// otherwise be two answers to one question. `ui/document.js` builds the Open
/// dialog's filter out of this, and `corpus/local.js` decides with it which
/// files in a folder somebody dropped are worth probing; a list that grew an
/// entry in one and not the other would be a folder whose `.mxf` was invisible
/// to the scan and openable by hand, with nothing saying why.
///
/// The answer is a property of the build and cannot change while it runs, so it
/// is built once. Empty is a real answer — a demuxer that claims no extension at
/// all is reached by the dialog's "All files" entry and by a probe, which is
/// what stops this from being the *only* way in.
let claimed = null;
export function mediaExtensions() {
    if (claimed) return claimed;
    claimed = new Set();
    for (const d of bro.ffmpeg.demuxers || [])
        for (const e of d.extensions || []) if (e) claimed.add(String(e).toLowerCase());
    return claimed;
}

/// Does this path carry an extension some demuxer in this build claims?
///
/// A pre-filter over a directory and never a verdict: a file that passes may
/// still fail to open, and one that fails may open perfectly when named on the
/// command line. `corpus/local.js` probes what passes and refuses by name what
/// does not open.
export function looksLikeMedia(path) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ''));
    return !!m && mediaExtensions().has(m[1].toLowerCase());
}

/// The scheme a URL names, or '' for a plain path.
///
/// The parse is `format.js`'s — there were two of them and only one carried the
/// Windows drive-letter guard, so `C://media/x.mp4` drew a "Protocol: c · not in
/// this build" row for an ordinary path. The **policy** stays here, because it
/// is one: `file` comes back as '' because a `file:` URL is the long way of
/// writing a path, which is what `isLocalPath` in `export_writer.cpp` says too,
/// and the protocol column is about the ones somebody chose.
export function schemeOf(path) {
    const s = urlScheme(path);
    return s === 'file' ? '' : s;
}

/// Everything the render has to be told about the inputs, in spec order.
export function specInputs() {
    return inputs.map(asInput);
}

/// What a graph has to know about each `-i` beyond how to open it: which input
/// it is, what streams came back, and its name.
///
/// Index-aligned with `specInputs()` — the same list, so the `-i` number is one
/// fact rather than two. The streams are the probe's, because that is what
/// decides how many sockets a source card draws: an input with no sound in it
/// must not offer a pad the render cannot fill.
///
/// Here rather than in `export/spec.js`, where it was written, because it is a
/// statement about the input list and nothing else — and there are two callers
/// now. A recording's graph is derived from the same document inputs a render's
/// is (`graph/record.js`), and a second copy of this shape would be a second
/// answer to which streams a device offers.
///
/// `sampleRate` is here for one reason and it is worth naming: a clip's **speed**
/// is printed as `asetrate=<rate>*<speed>,aresample=<rate>`, and `asetrate` takes
/// a number rather than an expression over the input's own rate — so the graph has
/// to be told what the file is at. The renderer does not need it (libav's `swr`
/// reads it off the decoder), which is exactly what this list is for. Zero for an
/// input with no sound; `graph/derive.js` refuses a sped-up clip whose rate it does
/// not know rather than printing a chain that would resample to the wrong rate.
export function specInputInfo() {
    return inputs.map((i) => ({
        id: i.id,
        name: i.name,
        path: i.path,
        streams: streamKinds(i),
        sampleRate: (i.probe && i.probe.audio && i.probe.audio.sampleRate) || 0,
    }));
}
