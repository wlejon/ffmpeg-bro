// Turning a drop of files into the inputs they are.
//
// An `-i` is usually a file, and three of ffmpeg's are not: a numbered run of
// images read by `image2`, one picture held for a chosen length, and a list of
// files read end to end by the `concat` demuxer. What this module does is the
// step before any of that — decide, out of what somebody dropped, which of
// those they meant, and build the input record for it.
//
// **Nothing here is a new kind of input option.** `-framerate`,
// `-start_number`, `-pattern_type` and `-loop` are options of the `image2`
// demuxer; `safe` is the `concat` demuxer's. They go in the same bag
// `-probesize` goes in and are printed in front of the same `-i`, which is the
// point: an image sequence is not a feature of this application, it is a
// demuxer with options, and the Sources stage edits it as one.
//
// **Two of the numbers below are decisions and they are marked as such.** A
// sequence has no frame rate — three hundred pictures are three hundred
// pictures and nothing on disk says how long each is on screen — and a still
// has no duration at all. Both defaults are written into the input's own
// option bag rather than kept somewhere private, so the command bar prints
// them, the Sources stage edits them, and there is nowhere for the application
// to be quietly holding a number nobody chose.
//
// **Three things called concat, and they are not each other.** The `concat`
// *demuxer* here reads several files as one input, before any decoding, and
// wants them encoded compatibly. The `concat` *filter* joins decoded streams
// inside the graph and does not care what they were. A timeline with two clips
// laid end to end is neither — it is an edit, and it renders through the
// compositor. Whichever one is being offered, say which.

import { isImagePath } from './inputs.js';

/// What a sequence is given when nothing says otherwise. Twenty-five because
/// that is `image2`'s own default, so a sequence opened with no `-framerate`
/// at all is the same length — the difference is only that this one is said
/// out loud where it can be changed.
export const SEQUENCE_FPS = 25;

/// How long a still is held when nobody has said. There is no right answer,
/// which is exactly why it goes on the input as `-t` rather than into a clip's
/// length: five seconds is a starting point somebody can argue with, and the
/// place to argue with it is the same place the number is printed.
export const STILL_SECONDS = 5;

/// One `-i` for a numbered run of files.
///
/// `-start_number` is set even when the run starts at 1, because it is not a
/// no-op that could be left out: `image2` looks for the first five numbers
/// from zero and gives up, so a run that begins at 1000 is unopenable without
/// it, and a run that begins at 1 is only openable *by accident*. A command
/// that works because of a default nobody can see is a command that stops
/// working when the numbers change.
export function sequenceSpec(seq, opts = {}) {
    return {
        path: seq.pattern,
        // Forced rather than probed. `image2` and the `*_pipe` demuxers both
        // answer for a `.png`, and only one of them reads a run of them.
        format: 'image2',
        options: {
            framerate: String(opts.fps || SEQUENCE_FPS),
            start_number: String(seq.start),
        },
        sequence: seq,
    };
}

/// One `-i` for a single picture, held.
///
/// `-loop 1` and `-t` are one gesture and are written together. Without the
/// loop the input is one picture and no time at all — libavformat says so and
/// bro's `<video>` agrees, since it drives its clock from decoded pictures and
/// one picture is nothing to advance through. Without the `-t` the loop never
/// ends and nothing knows how long the input is. Either on its own is a clip
/// that cannot be laid out.
export function stillSpec(path, opts = {}) {
    return {
        path,
        format: 'image2',
        options: {
            loop: '1',
            framerate: String(opts.fps || SEQUENCE_FPS),
        },
        to: opts.seconds || STILL_SECONDS,
    };
}

/// One `-i` for several files read end to end, through the `concat` demuxer.
///
/// The list is a file, so it has to be written before anything can be opened —
/// which is the whole difference between this and the other two. Each entry
/// carries its own duration, and that is not decoration: without them the
/// demuxer reports no length until something has read to the end of the last
/// file, and an input of no length lays out as no clip. The durations come
/// from probing each file, which is work this has to do anyway to be able to
/// refuse a file it cannot read.
export function concatSpec(paths, opts = {}) {
    const entries = [];
    for (const path of paths) {
        let duration = 0;
        try { duration = bro.ffmpeg.probe(path).format.duration || 0; } catch (e) { /* unreadable */ }
        entries.push({ path, duration });
    }
    const list = bro.ffmpeg.concatList(
        bro.ffmpeg.tempPath(opts.name || `concat-${Date.now()}.txt`), entries);
    return {
        path: list,
        format: 'concat',
        // Absolute paths in the list need it, and every path this application
        // holds is absolute.
        options: { safe: '0' },
        parts: entries.map((e) => e.path),
    };
}

/// What a drop amounts to: one entry per input, in the order they should be
/// opened.
///
/// The grouping and every refusal in it is `scanForSequences` in
/// src/native/ffmpeg_sequence.cpp — the last run of digits is the number, a
/// run of one file is a still, zero padding is meaningful and unpadded
/// numbering is not, a gap is reported rather than closed, folders are read one
/// level deep. It is native because it is a filesystem walk and because the
/// guess wants to be in one place; what is here is only the turning of its
/// answer into inputs.
export function openables(paths) {
    let scan = { sequences: [], singles: paths.slice() };
    try { scan = bro.ffmpeg.sequences(paths); } catch (e) { /* left as dropped */ }

    const out = scan.sequences.map((seq) => ({
        kind: 'sequence',
        seq,
        spec: sequenceSpec(seq),
        label: `${seq.count} frames`,
    }));
    for (const path of scan.singles) {
        // A lone picture is a still, and a still is a decision about how long
        // it is on screen. Made here so that dropping one does something, and
        // written into the input where it can be seen and changed.
        if (isImagePath(path))
            out.push({ kind: 'still', spec: stillSpec(path), label: 'a still' });
        else
            out.push({ kind: 'file', path, spec: { path }, label: '' });
    }
    return out;
}

/// A path typed into the Sources stage, as the input it describes.
///
/// Typing `shot_%04d.png` means a sequence in exactly the way dropping the
/// folder does, and a path that is one picture means a still. Anything else is
/// a file or a URL and nothing is added to it.
export function typedSpec(path) {
    if (bro.ffmpeg.hasFramePattern(path)) {
        // The numbers on disk, if there are any there yet: a pattern typed by
        // hand is often typed before the render that fills it in.
        let seq = null;
        try {
            const dir = path.replace(/[/\\][^/\\]*$/, '');
            const scan = bro.ffmpeg.sequences([dir]);
            seq = scan.sequences.find((s) => s.pattern === path) || null;
        } catch (e) { /* nothing there to find */ }
        return sequenceSpec(seq || { pattern: path, start: 1, count: 0 });
    }
    if (isImagePath(path)) return stillSpec(path);
    return { path };
}
