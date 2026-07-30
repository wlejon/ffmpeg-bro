// The renders that will succeed and be wrong.
//
// Everything here produces a file which is technically valid and practically
// not what was wanted, which is the failure worth catching. An encoder that
// refuses says so itself and needs no help from this.

import { project } from '../project.js';
import { basename } from '../format.js';
import { settings, activeVideoCodec, outputFps } from './state.js';
import { encoderInfo, audioInfo, muxerInfo, codecTags } from './capabilities.js';
import { codecOf, labelOf } from './streams.js';
import { isCopy, copiedStream, copiedInput, keyframesFor, keyframeAtOrBefore,
         containerOf, parseCopy } from './copy.js';
import { kindOf, schemeOf, protocolLinked } from './destination.js';
import { versionProblems } from './versions.js';
import { readsInput, readStream, subtitleCodecsOf,
         defaultSubtitleCodec } from './subtitles.js';
import { parsePad, isPad } from './pads.js';
import { isEmpty as noUserNodes } from '../graph/overlay.js';
import { whereIs } from '../graph/check.js';
import { range, freshSpec, currentSpec, currentGraph, needsGraph } from './spec.js';
import { deviceOfEncoder } from '../hardware.js';

/// How many frames this render will write. A single-frame range written into
/// one picture is exactly what somebody means by "a still of this moment";
/// the same path over a hundred frames is not.
function outputFrames() {
    return Math.max(0, Math.round(range().length * outputFps()));
}

/// What a copied stream cannot do, said where the decision is taken.
///
/// **A copied stream is not decoded**, so nothing on the Compose stage and
/// nothing on the Graph stage reaches it: no crop, no scale, no opacity, no
/// filter, no second clip stacked over it. Every one of those is a setting
/// somebody made that will not be in the file, and a render that succeeded
/// while ignoring them is the exact failure this whole list exists for — worse
/// here than anywhere else, because the output *looks* like a successful export
/// and is the input again.
///
/// The keyframe is the other half. A copy can only begin on one, so an in-point
/// between two of them silently moves; it is said with both numbers, because
/// "it will start earlier" without saying how much earlier is not actionable.
function copyWarnings(list) {
    const out = [];
    const copies = list.filter(isCopy);
    if (!copies.length) return out;

    const clips = project.clips.length;
    const videoCopies = copies.filter((s) => s.kind === 'video');

    // Which inputs a copy reads, so the message can name the one that is going
    // into the file rather than saying "an input".
    for (const s of copies) {
        const at = parseCopy(s.source);
        const stream = copiedStream(s);
        const input = copiedInput(s);
        const where = `${labelOf(list, list.indexOf(s))} copies ${input ? input.name : 'an input'}`;
        if (!stream) {
            out.push(`${where}, and that stream is not in it any more — pick another, or ` +
                     'feed the row from the edit');
            continue;
        }

        const box = at ? containerOf(at.input) : '';
        if (box && box === settings.container && copies.length === list.length)
            out.push(`this is a rewrap into the container the file is already in, so the ` +
                     `output would be a copy of ${input ? input.name : 'the input'} — pick ` +
                     'another container, or trim it with From and To');

        if (s.kind !== 'video') continue;
        const kf = keyframesFor(s);
        const want = Number(s.copyFrom) || 0;
        const land = keyframeAtOrBefore(kf, want);
        if (land !== null && want - land > 0.001)
            out.push(`${where} from ${want.toFixed(2)} s, and the nearest keyframe at or ` +
                     `before that is ${land.toFixed(2)} s — a copy starts there, so ` +
                     `${(want - land).toFixed(2)} s more than you asked for will be in the file`);
    }

    if (!videoCopies.length) return out;

    // The edit, against a stream that is not decoded. Counted rather than
    // listed: what matters is that the picture in the file is one input's and
    // not the composition on screen.
    if (clips > 1)
        out.push(`the timeline has ${clips} clips and the picture is copied — a copy is one ` +
                 'input’s packets, so nothing stacked, cut or laid beside it will be in the ' +
                 'file');

    if (!noUserNodes())
        out.push('the filters on the Graph stage do not reach a copied stream — it is never ' +
                 'decoded, so there is no picture for a filter to work on');

    const first = project.clips[0];
    if (first) {
        const x = first.xform || {};
        const crop = x.crop || {};
        const cropped = (crop.l || 0) + (crop.t || 0) + (crop.r || 0) + (crop.b || 0) > 0.001;
        if (cropped || (x.opacity !== undefined && x.opacity < 0.999))
            out.push('the crop and opacity on this clip do not reach a copied stream — the ' +
                     'packets go into the file as they are');
    }

    for (const s of videoCopies) {
        const stream = copiedStream(s);
        if (!stream || !stream.width) continue;
        const w = stream.displayWidth || stream.width;
        const h = stream.displayHeight || stream.height;
        if (w !== settings.width || h !== settings.height)
            out.push(`the output is set to ${settings.width}×${settings.height} and the ` +
                     `copied picture is ${w}×${h} — a copy is not resized, so the file will ` +
                     'be the second of those');
    }
    return out;
}

/// What the destination will succeed at and be wrong about.
///
/// Three of these are about a shape rather than a setting, which is why they
/// are here rather than on a control: a segment that cannot start where it was
/// asked to, an index that cannot be moved to the front of something that
/// cannot be rewound, and a destination list with nothing in it.
/// What a subtitle row will succeed at and be wrong about.
///
/// **The one that matters most is not a failure at all**: a soft subtitle
/// track is written correctly, plays correctly in a player, and is invisible in
/// this application's viewer for the whole time you are working. bro's
/// `<video>` decodes pictures and sound, and a stream a player can switch off
/// is neither. Said out loud once, on the stage where the row was added,
/// because the alternative is somebody checking the viewer, seeing nothing, and
/// concluding the track was not written.
///
/// It now names the other thing they may have meant rather than only the
/// absence. `Burn in`, on a clip's properties panel, puts the cues *into* the
/// picture and the viewer shows that, because it is a filter on the clip's own
/// chain like any other. Naming it here is not a suggestion to use it — the two
/// are different statements about the finished file — but somebody who wanted
/// burned-in subtitles and reached for a stream row should find that out on
/// this stage rather than in a player.
function subtitleWarnings(list) {
    const out = [];
    const subs = list.filter((s) => s.kind === 'subtitle');
    if (!subs.length) return out;

    const holds = subtitleCodecsOf(settings.container);
    for (const s of subs) {
        const where = labelOf(list, list.indexOf(s));
        const stream = readStream(s);
        if (!readsInput(s)) {
            out.push(`${where} has no file to read cues from, so it will not be written — ` +
                     'add a subtitle file on the Sources stage');
            continue;
        }
        if (!stream) {
            out.push(`${where} reads a stream that is not in its input any more — pick ` +
                     'another');
            continue;
        }
        if (isCopy(s)) {
            // A copy is the codec that is already there, and the container has
            // to hold that one rather than one it could encode.
            if (holds.length && holds.indexOf(stream.codec) < 0 &&
                !holds.some((h) => h === stream.codec))
                out.push(`${where} copies a ${stream.codec} track and ` +
                         `${settings.container} does not hold one — convert it instead, ` +
                         `which is what ${defaultSubtitleCodec(settings.container) || 'the ' +
                         'container'} is for`);
        }
    }

    // **The one thing an attachment is for.** An ASS track names its fonts by
    // name — `Style: Default,Arial,48,…` — and nothing about the font travels
    // in the cues, so a player without that font substitutes one and every
    // position, line break and timing of the text moves with it. Embedding the
    // font as an attachment stream is what `-attach` is for and it is the only
    // way to make an ASS track look the same anywhere. Said here because this
    // is where the ASS row was added, and because an attachment row on its own
    // gives nobody a reason to add one.
    const styled = subs.some((s) => {
        const codec = isCopy(s) ? (readStream(s) || {}).codec
                                : (s.codec || defaultSubtitleCodec(settings.container));
        return codec === 'ass' || codec === 'ssa';
    });
    const fonts = list.filter((s) => s.kind === 'attachment' && s.path).length;
    if (styled && !fonts)
        out.push('an ASS track names its fonts by name and carries none of them, so a ' +
                 'player without them substitutes and every line moves — attach the fonts ' +
                 'as streams (+ Attachment), which is what ffmpeg’s -attach is for');

    if (!holds.length)
        out.push(`${settings.container} holds no subtitle codec this build can write, so ` +
                 `${subs.length === 1 ? 'this subtitle stream' : 'these subtitle streams'} ` +
                 'will stop the render — burn them into the picture instead, with a ' +
                 'subtitles filter on the Graph stage');
    else
        out.push('the viewer cannot show a soft subtitle track — bro’s <video> decodes ' +
                 'pictures and sound, and a track a player can switch off is neither. It ' +
                 'is in the file; open the result to see it. What the viewer does show is ' +
                 'a track burned in: Burn in, on the clip’s properties panel, puts a ' +
                 'subtitles filter on that clip and the picture changes in front of you — ' +
                 'which is a different statement about the finished file, not a preview ' +
                 'of this one');
    return out;
}

/// What a stream fed from a graph pad will be refused for, said here first.
///
/// **The renderer refuses every one of these before it opens a file** — a label
/// naming no pad, a picture pad in a sound stream, `pad:` with no graph at all —
/// and it says so in almost these words, listing the labels there are. The
/// wording is deliberately close, because two answers to the same question that
/// differ in substance are two answers: this one arrives where the decision is
/// taken, which is the standing rule, and the native one is what actually stops
/// the render if this is ever wrong.
///
/// The last of them is not a refusal at all. An output nothing reads is a pad
/// libavfilter drains and the render is perfectly good; it is worth a word
/// because the reason somebody placed one is to map it, and a stream row that
/// was never added looks exactly like one that was.
function padWarnings(list) {
    const out = [];
    const rows = list.filter(isPad);
    const g = currentGraph();
    const graph = g && g.ok ? g.graph : null;
    const named = graph
        ? graph.nodes.filter((n) => n.kind === 'sink' && n.name !== undefined && n.name)
        : [];

    if (rows.length && !currentSpec().filterGraph) {
        // Either there is no graph of your own at all, or the derivation
        // refused one — and which of the two it is is the whole of what there
        // is to do about it, so it is said rather than summarised.
        const why = noUserNodes()
            ? 'there is nothing on the Graph stage, so the picture comes straight from the ' +
              'timeline and there are no pads to name'
            : `the graph was refused: ${(g && g.reason) || 'it cannot be expressed for this edit'}`;
        out.push(`${rows.length === 1 ? 'a stream is' : `${rows.length} streams are`} fed from ` +
                 `a pad of the filter graph and this render has no graph in it — ${why}. ` +
                 'The renderer refuses pad: outright when there is nothing to read it from.');
        return out;
    }

    const pads = (audio) => {
        const some = named.filter((n) => ((n.stream || 'v') === 'a') === audio)
                          .map((n) => `[${n.name}]`);
        return some.length ? some.join(', ') : 'none';
    };

    for (const s of rows) {
        const where = labelOf(list, list.indexOf(s));
        const label = parsePad(s.source);
        const found = named.find((n) => n.name === label);
        if (!found) {
            out.push(`${where} is fed from [${label}] and this graph has no pad called that: ` +
                     `its pictures come out of ${pads(false)} and its sound out of ` +
                     `${pads(true)} — pick another, or rename the output on the Graph stage`);
            continue;
        }
        const audio = (found.stream || 'v') === 'a';
        if (audio !== (s.kind === 'audio'))
            out.push(`[${label}] is ${audio ? 'sound' : 'a picture'}, and ${where} is ` +
                     `${s.kind === 'audio' ? 'a sound stream' : 'a picture stream'} — the ` +
                     'renderer refuses that pairing before it opens the file');
    }

    for (const n of named) {
        if (rows.some((s) => parsePad(s.source) === n.name)) continue;
        out.push(`nothing in the file is fed from [${n.name}] — the pad is drained and ` +
                 'thrown away, which is legal and is probably not why you named it. Add a ' +
                 'stream on this stage and pick it as the source.');
    }
    return out;
}

function destinationWarnings() {
    const out = [];
    const muxer = muxerInfo(settings.container) || { name: settings.container };
    const kind = kindOf(muxer);

    if (kind === 'several') {
        const usable = (settings.destinations || []).filter((d) => d.path);
        if (!usable.length)
            out.push('tee has no destinations, so this render has nowhere to go — add one');
        for (const d of usable) {
            const scheme = schemeOf(d.path);
            if (scheme && !protocolLinked(scheme))
                out.push(`this build has no ${scheme} output protocol, so ${d.path} will ` +
                         'fail at open with a message about a filename');
            if (!d.format && scheme)
                out.push(`${d.path} has no -f, and a URL has no extension for libavformat ` +
                         'to guess a muxer from — name one');
        }
        if (usable.length === 1)
            out.push('one destination through tee is one destination with a layer of ' +
                     'escaping over it — pick that muxer directly unless a second is coming');
    }

    // The versions, which are destinations too — and the one thing that can go
    // wrong with a second output is the whole of what this list is about: it
    // succeeds, and one of the two files it paid for is not there afterwards.
    out.push(...versionProblems());
    for (const v of settings.versions || []) {
        if (!v.path) continue;
        const vs = schemeOf(v.path);
        if (vs && !protocolLinked(vs))
            out.push(`this build has no ${vs} output protocol, so the version at ` +
                     `${v.path} will fail at open — after the render it comes after ` +
                     'has been written, which is the expensive way to find out');
        // Said here rather than refused in `activeVersions`, which drops it
        // silently: a row that is filled in except for the one field that
        // makes it a version is somebody halfway through, and a render that
        // quietly wrote one file where the stage showed two is the failure.
        if (!v.width && !v.height && !v.format)
            out.push(`the version at ${v.path} is the same size and the same muxer as the ` +
                     'render, so it is a second encode of the identical file — give it a ' +
                     'size, or take it off');
    }

    const scheme = schemeOf(settings.path);
    if (kind === 'stream' && scheme && !protocolLinked(scheme))
        out.push(`this build has no ${scheme} output protocol — the render will fail at ` +
                 'open, with a message about a filename rather than about the protocol');

    // An index at the front needs the file rewound after the trailer, and
    // nothing that goes down a socket can be rewound. It fails at the end of
    // the render, after everything has been sent, which is the worst moment.
    if (kind === 'stream' && settings.faststart && /mp4|mov/.test(settings.container))
        out.push('+faststart rewrites the file after the trailer, and a stream cannot be ' +
                 'rewound — take it off, or use -movflags frag_keyframe+empty_moov, which ' +
                 'is what makes an mp4 writable to a socket at all');

    // **A segment can only start on a keyframe.** The renderer asks for one
    // every two seconds unless told otherwise, so a four-second GOP against a
    // two-second segment time gives segments of four seconds and a playlist
    // that quietly disagrees with what was set. It succeeds, which is what
    // makes it belong in this list.
    const segTime = Number(settings.extraFormat.hls_time ||
                           settings.extraFormat.segment_time || 0);
    if (segTime > 0) {
        const gop = settings.gopSeconds || 2;
        if (gop > segTime + 0.01)
            out.push(`segments are asked for every ${segTime} s and a keyframe every ` +
                     `${gop} s — a segment can only start on a keyframe, so they will come ` +
                     `out ${gop} s long. Set the keyframe interval to ${segTime} s or less.`);
    }
    return out;
}

/// Where the picture is, against where the encoder can take it from.
///
/// Two renders that succeed and are not what was wanted, and one that does not
/// succeed at all but fails a long way from the decision that caused it.
///
///   - **The picture ends on a card and the encoder is a software one.** The
///     writer refuses this outright — it would be a download per frame done
///     quietly on behalf of a render that asked for the opposite — and the
///     refusal arrives at `Writer::open`, which is after the Render button.
///     Said here instead, where the encoder is being chosen.
///   - **The encoder runs on a card and the picture never gets there.** It
///     works: the writer uploads. It is also the thing somebody thinks they
///     have avoided by picking a hardware encoder, so it is worth stating that
///     a copy is still happening and where to put the `hwupload` that removes
///     it.
///   - **A hardware decode on an input.** Measured slower here than the CPU,
///     said on Sources where it is chosen and again here, because a render is
///     where somebody notices it took longer than they expected.
function hardwareWarnings() {
    const out = [];
    const spec = currentSpec();
    const codec = activeVideoCodec();
    const device = deviceOfEncoder(codec);
    // **Asked of the graph, by following the wire the encoder is fed from.**
    //
    // This was a text scan for `hwupload` in the last chain of
    // `spec.filterGraph`, which is the wrong question twice over. A chain is
    // not a wire — the run that feeds the sink can have crossed onto a card
    // several filters earlier — and, worse, the last chain is not the sink's:
    // `print()` walks `g.nodes` in array order and `derive()` builds the audio
    // runs *after* the video sink, so for any render with sound in it the last
    // chain is an `atrim`. The test was therefore unconditionally false
    // whenever there was a soundtrack, and toggling Include audio flipped a
    // warning about the picture.
    //
    // `whereIs` is `check.js`'s own resolution of the same fact, which walks
    // upstream rather than along the array and is what the Graph stage already
    // names nodes with.
    let endsUp = false;
    if (spec.filterGraph) {
        const g = currentGraph() || { ok: false };
        const graph = g.ok ? g.graph : null;
        const sink = graph ? graph.byAnchor('out:v') : null;
        const edge = sink ? graph.inEdges(sink)[0] : null;
        const feeds = edge ? graph.node(edge.from) : null;
        endsUp = !!feeds && whereIs(graph, feeds) === 'device';
    }

    if (endsUp && !device)
        out.push(`this render leaves its picture on the card and ${codec} cannot take it ` +
                 'from there — pick a hardware encoder, or put an hwdownload after the ' +
                 'last hwupload');
    else if (device && !endsUp && spec.filterGraph)
        out.push(`${codec} runs on the ${device} and the picture is being made in system ` +
                 'memory, so every frame is copied up to it — an hwupload on the last wire ' +
                 'removes that copy');

    const decoding = (spec.inputs || []).filter((i) => i.hwaccel).length;
    if (decoding)
        out.push(`${decoding} input${decoding === 1 ? '' : 's'} decode on a card, which is ` +
                 'measured slower here than the CPU — see the note on Sources');
    return out;
}

export function warnings() {
    const out = [];
    // One derivation for the whole of this answer. Everything below reads
    // `currentSpec()`; this is the only place that builds one.
    freshSpec();
    out.push(...destinationWarnings());

    // The filters go through libavfilter, and the way they get there is
    // `spec.filterGraph`. If the derivation refused, the render still happens —
    // through the internal compositor, which cannot run a filter — so the file
    // would come out silently missing what was put on the graph. That is
    // exactly the outcome the lock rules exist to prevent, and it deserves to
    // be said in the same place as everything else that will succeed and be
    // wrong.
    //
    // The reason is asked for rather than summarised, because there are now two
    // very different ones — an edit the derivation cannot describe, and a graph
    // you are half way through wiring — and "cannot be expressed" is a useless
    // thing to read when what is actually wrong is that one input of an
    // `overlay` you placed a minute ago has nothing on it.
    out.push(...copyWarnings(settings.streams));

    // **Two reasons a render needs the graph and one sentence each**, because
    // what is lost differs: a filter is not applied, and a generator clip has
    // nothing at all for the compositor to read — there is no `-i` behind it, so
    // the render fails on an empty path rather than coming out plainer than
    // asked for. `needsGraph()` is the one place that knows the two reasons.
    if (needsGraph(currentSpec()) && !currentSpec().filterGraph) {
        const why = currentGraph() || {};
        const said = why.reason || 'the graph cannot be expressed for this edit';
        const generators = (currentSpec().clips || []).filter((c) => c && c.generator).length;
        const many = `${generators} generators on the timeline are`;
        out.push(generators
            ? `${generators === 1 ? 'a generator on the timeline is' : many} rendered by the ` +
              `filter graph, and this render has none — ${said}`
            : `this render would go through the internal compositor without your ` +
              `filters — ${said}`);
    }

    out.push(...padWarnings(settings.streams));

    out.push(...hardwareWarnings());

    // image2 writes one file per frame and the numbering is in the filename,
    // so a path with no pattern in it is one picture written over itself for
    // every frame of the range. It succeeds, and what is left is the last
    // frame — which is the shape of failure this whole list is for.
    if (settings.container === 'image2' && !bro.ffmpeg.hasFramePattern(settings.path) &&
        !settings.extraFormat.update && outputFrames() > 1)
        out.push(`${settings.path ? basename(settings.path) : 'the output'} has no frame ` +
                 'number in it, so every frame would be written over the one before — put ' +
                 '%04d in the name, or say One picture');

    // A row still being drafted is not sent to the renderer — an `-attach`
    // with nothing after it is not a command anybody should be shown — so the
    // stream is silently absent from the file unless this says otherwise.
    const draft = settings.streams.filter((s) => s.kind === 'attachment' && !s.path).length;
    if (draft)
        out.push(`${draft} attachment${draft === 1 ? ' has' : 's have'} no file yet, so ` +
                 `${draft === 1 ? 'it' : 'they'} will not be written`);

    // Not every container holds every kind of stream, and the failure arrives
    // at write_header long after the row was added.
    //
    // **This is the one capability libavformat will not answer.** There is no
    // flag on an AVOutputFormat for attachments and no `avformat_query_codec`
    // that covers them — ffmpeg's own CLI adds the stream and lets the muxer
    // complain — so the two that hold one are named here rather than asked
    // for, exactly as `codecTags` names its candidate fourccs. Everything else
    // on this stage comes from a query; this does not, and saying so is
    // cheaper than pretending otherwise.
    const atts = settings.streams.filter((s) => s.kind === 'attachment' && s.path).length;
    if (atts && settings.container !== 'matroska' && settings.container !== 'webm')
        out.push(`${settings.container} cannot hold an attachment — Matroska can`);
    const audioTracks = settings.streams.filter((s) => s.kind === 'audio').length;
    if (audioTracks > 1 && settings.container === 'webm')
        out.push('WebM players commonly show only the first audio track');

    out.push(...subtitleWarnings(settings.streams));

    // A fourcc belongs to a container's vocabulary and not to a codec, so a tag
    // that was right for the mp4 it was chosen in stops the muxer dead in the
    // Matroska it is now being written to — at write_header, with "Invalid data
    // found when processing input" and no mention of the tag.
    for (const s of settings.streams) {
        if (!s.tag) continue;
        const known = codecTags(settings.container, codecOf(s));
        if (known.indexOf(s.tag) < 0)
            out.push(`the ${settings.container} muxer does not know '${s.tag}' as a tag for ` +
                     `${codecOf(s) || 'this codec'}, and will refuse the file`);
    }

    const c = muxerInfo(settings.container);
    const codec = activeVideoCodec();
    const info = encoderInfo(codec);
    const w = settings.width, h = settings.height;

    // A muxer that will hold none of the encoders on offer is a real answer —
    // `bin`, `rtp_mpegts`, half of the raw writers — and it has to be said
    // where the choice was made rather than at write_header. The picker marks
    // it too; this is what makes it impossible to walk past.
    // Only the streams an encoder is actually opened for. A copied stream has
    // none, so a container that holds no encoder this build has is no obstacle
    // to it — MPEG-TS taking a copied H.264 is the ordinary case, and reading
    // the encoder list at it would refuse the render that works.
    const wantsVideo = settings.streams.some((s) => s.kind === 'video' && !isCopy(s));
    const wantsAudio = settings.audio &&
                       settings.streams.some((s) => s.kind === 'audio' && !isCopy(s));
    if (c && wantsVideo && !c.videoCodecs.length)
        out.push(`no video encoder this build offers can go in ${c.name} — ` +
                 'take the video stream out on this stage, or pick another container');
    else if (c && info && wantsVideo && c.videoCodecs.indexOf(codec) < 0)
        out.push(`${c.label} cannot hold ${info.label} — the muxer will refuse it`);
    if (c && wantsAudio && !c.audioCodecs.length)
        out.push(`no audio encoder this build offers can go in ${c.name} — ` +
                 'this render will be silent or be refused');
    else if (c && wantsAudio && settings.audioCodec &&
             c.audioCodecs.indexOf(settings.audioCodec) < 0)
        out.push(`${c.label} cannot hold ${(audioInfo(settings.audioCodec) || {}).label}`);

    // Everything from here down is about a picture being made, which a render
    // whose video is copied is not doing: the size, the shape and the rate in
    // the file are the input's.
    const pix = settings.pixelFormat || (info && info.pixelFormats[0]) || 'yuv420p';
    if (wantsVideo && /420/.test(pix) && ((w % 2) || (h % 2)))
        out.push(`${pix} needs even dimensions — ${w}×${h} will fail`);

    const canvasAspect = project.height ? project.width / project.height : 0;
    const outAspect = h ? w / h : 0;
    if (wantsVideo && canvasAspect && Math.abs(outAspect - canvasAspect) > 0.01)
        out.push('the output is a different shape from the canvas — the picture will be stretched');

    const fps = outputFps();
    if (wantsVideo && project.fps && fps > project.fps + 0.01)
        out.push(`${fps} fps from a ${project.fps.toFixed(3)} fps timeline duplicates frames`);

    if (wantsVideo && info && info.hardware && settings.rate === 'quality')
        out.push('a GPU encoder trades quality per bit for speed — compare it against x264 before trusting the number');

    if (settings.rate === 'lossless')
        out.push('lossless output is commonly ten to thirty times larger than CRF 20');

    return out;
}
