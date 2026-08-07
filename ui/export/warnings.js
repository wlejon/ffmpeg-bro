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
import { readsInput, readStream, subtitleCodecsOf, defaultSubtitleCodec } from './subtitles.js';
import { parsePad, isPad } from './pads.js';
import { isEmpty as noUserNodes } from '../graph/overlay.js';
import { whereIs } from '../graph/check.js';
import { range, freshSpec, currentSpec, currentGraph, needsGraph } from './spec.js';
import { deviceOfEncoder } from '../hardware.js';

const err = (text) => ({ level: 'error', text });
const caution = (text) => ({ level: 'caution', text });


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
            out.push(err(`${where}, and that stream is not in it any more — pick another, or ` +
                         'feed the row from the edit'));
            continue;
        }

        const box = at ? containerOf(at.input) : '';
        if (box && box === settings.container && copies.length === list.length)
            out.push(caution(`this is a rewrap into the container the file is already in, so the ` +
                             `output would be a copy of ${input ? input.name : 'the input'} — pick ` +
                             'another container, or trim it with From and To'));

        if (s.kind !== 'video') continue;
        const want = Number(s.copyFrom) || 0;
        if (want <= 0) continue;
        const kf = keyframesFor(s);
        const land = keyframeAtOrBefore(kf, want);
        if (land !== null && want - land > 0.001)
            out.push(caution(`${where} from ${want.toFixed(2)} s, and the nearest keyframe at or ` +
                             `before that is ${land.toFixed(2)} s — a copy starts there, so ` +
                             `${(want - land).toFixed(2)} s more than you asked for will be in the file`));
    }

    if (!videoCopies.length) return out;

    if (clips > 1)
        out.push(caution(`the timeline has ${clips} clips and the picture is copied — a copy is one ` +
                         'input’s packets, so nothing stacked, cut or laid beside it will be in the ' +
                         'file'));

    if (!noUserNodes())
        out.push(caution('the filters on the Graph stage do not reach a copied stream — it is never ' +
                         'decoded, so there is no picture for a filter to work on'));

    const first = project.clips[0];
    if (first) {
        const x = first.xform || {};
        const crop = x.crop || {};
        const cropped = (crop.l || 0) + (crop.t || 0) + (crop.r || 0) + (crop.b || 0) > 0.001;
        if (cropped || (x.opacity !== undefined && x.opacity < 0.999))
            out.push(caution('the crop and opacity on this clip do not reach a copied stream — the ' +
                             'packets go into the file as they are'));
    }

    for (const s of videoCopies) {
        const stream = copiedStream(s);
        if (!stream || !stream.width) continue;
        const w = stream.displayWidth || stream.width;
        const h = stream.displayHeight || stream.height;
        if (w !== settings.width || h !== settings.height)
            out.push(caution(`the output is set to ${settings.width}×${settings.height} and the ` +
                             `copied picture is ${w}×${h} — a copy is not resized, so the file will ` +
                             'be the second of those'));
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
            out.push(caution(`${where} has no file to read cues from, so it will not be written — ` +
                             'add a subtitle file on the Sources stage'));
            continue;
        }
        if (!stream) {
            out.push(err(`${where} reads a stream that is not in its input any more — pick ` +
                         'another'));
            continue;
        }
        if (isCopy(s)) {
            if (holds.length && holds.indexOf(stream.codec) < 0 &&
                !holds.some((h) => h === stream.codec))
                out.push(err(`${where} copies a ${stream.codec} track and ` +
                             `${settings.container} does not hold one — convert it instead, ` +
                             `which is what ${defaultSubtitleCodec(settings.container) || 'the ' +
                             'container'} is for`));
        }
    }

    const styled = subs.some((s) => {
        const codec = isCopy(s) ? (readStream(s) || {}).codec
                                : (s.codec || defaultSubtitleCodec(settings.container));
        return codec === 'ass' || codec === 'ssa';
    });
    const fonts = list.filter((s) => s.kind === 'attachment' && s.path).length;
    if (styled && !fonts)
        out.push(caution('an ASS track names its fonts by name and carries none of them, so a ' +
                         'player without them substitutes and every line moves — attach the fonts ' +
                         'as streams (+ Attachment), which is what ffmpeg’s -attach is for'));

    if (!holds.length)
        out.push(err(`${settings.container} holds no subtitle codec this build can write, so ` +
                     `${subs.length === 1 ? 'this subtitle stream' : 'these subtitle streams'} ` +
                     'will stop the render — burn them into the picture instead, with a ' +
                     'subtitles filter on the Graph stage'));
    else
        out.push(caution('the viewer shows a soft track as the cues it is — Cues on the monitor ' +
                         '(T) draws them over the picture, unstyled, and turns off the way a soft ' +
                         'track does. What it cannot show is how they will *look*: a soft track is ' +
                         'styled by whatever player opens the file, so the words are a preview and ' +
                         'their appearance is not one. Burn in, on the clip’s properties panel, is ' +
                         'the other thing and shows exactly what will be there — because then the ' +
                         'cues are the picture, which is a different statement about the file'));
    return out;
}

function padWarnings(list) {
    const out = [];
    const rows = list.filter(isPad);
    const g = currentGraph();
    const graph = g && g.ok ? g.graph : null;
    const named = graph
        ? graph.nodes.filter((n) => n.kind === 'sink' && n.name !== undefined && n.name)
        : [];

    if (rows.length && !currentSpec().filterGraph) {
        const why = noUserNodes()
            ? 'there is nothing on the Graph stage, so the picture comes straight from the ' +
              'timeline and there are no pads to name'
            : `the graph was refused: ${(g && g.reason) || 'it cannot be expressed for this edit'}`;
        out.push(err(`${rows.length === 1 ? 'a stream is' : `${rows.length} streams are`} fed from ` +
                     `a pad of the filter graph and this render has no graph in it — ${why}. ` +
                     'The renderer refuses pad: outright when there is nothing to read it from.'));
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
            out.push(err(`${where} is fed from [${label}] and this graph has no pad called that: ` +
                         `its pictures come out of ${pads(false)} and its sound out of ` +
                         `${pads(true)} — pick another, or rename the output on the Graph stage`));
            continue;
        }
        const audio = (found.stream || 'v') === 'a';
        if (audio !== (s.kind === 'audio'))
            out.push(err(`[${label}] is ${audio ? 'sound' : 'a picture'}, and ${where} is ` +
                         `${s.kind === 'audio' ? 'a sound stream' : 'a picture stream'} — the ` +
                         'renderer refuses that pairing before it opens the file'));
    }

    for (const n of named) {
        if (rows.some((s) => parsePad(s.source) === n.name)) continue;
        out.push(caution(`nothing in the file is fed from [${n.name}] — the pad is drained and ` +
                         'thrown away, which is legal and is probably not why you named it. Add a ' +
                         'stream on this stage and pick it as the source.'));
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
            out.push(err('tee has no destinations, so this render has nowhere to go — add one'));
        for (const d of usable) {
            const scheme = schemeOf(d.path);
            if (scheme && !protocolLinked(scheme))
                out.push(err(`this build has no ${scheme} output protocol, so ${d.path} will ` +
                             'fail at open with a message about a filename'));
            if (!d.format && scheme)
                out.push(err(`${d.path} has no -f, and a URL has no extension for libavformat ` +
                             'to guess a muxer from — name one'));
        }
        if (usable.length === 1)
            out.push(caution('one destination through tee is one destination with a layer of ' +
                             'escaping over it — pick that muxer directly unless a second is coming'));
        if ((settings.keepTrying || {}).on)
            out.push(caution('“keep trying if it drops” does not apply to a tee — one fifo in ' +
                             'front of several destinations takes all of them through the recovery ' +
                             'of any one. Set a destination’s -f to fifo and give it ' +
                             'fifo_format=<muxer> to protect that destination alone'));
    }

    out.push(...versionProblems().map((t) => err(t)));
    for (const v of settings.versions || []) {
        if (!v.path) continue;
        const vs = schemeOf(v.path);
        if (vs && !protocolLinked(vs))
            out.push(err(`this build has no ${vs} output protocol, so the version at ` +
                         `${v.path} will fail at open — after the render it comes after ` +
                         'has been written, which is the expensive way to find out'));
        if (!v.width && !v.height && !v.format)
            out.push(caution(`the version at ${v.path} is the same size and the same muxer as the ` +
                             'render, so it is a second encode of the identical file — give it a ' +
                             'size, or take it off'));
    }

    const scheme = schemeOf(settings.path);
    if (kind === 'stream' && scheme && !protocolLinked(scheme))
        out.push(err(`this build has no ${scheme} output protocol — the render will fail at ` +
                     'open, with a message about a filename rather than about the protocol'));

    if (kind === 'stream' && (settings.keepTrying || {}).on) {
        out.push(caution('with “keep trying” on, a destination that cannot be reached at all is ' +
                         'not a refusal any more — the fifo opens it on its own thread, so the ' +
                         'render starts, queues, and reports at the end that it never connected'));
        out.push(caution('the queue drops rather than blocks, so a destination slower than the ' +
                         'encode loses packets instead of holding it up — which is right for a ' +
                         'live stream and is the only mode offered, because a fifo that blocks ' +
                         'cannot be stopped when the destination never comes up'));
    }

    if (kind === 'stream' && settings.faststart && /mp4|mov/.test(settings.container))
        out.push(err('+faststart rewrites the file after the trailer, and a stream cannot be ' +
                     'rewound — take it off, or use -movflags frag_keyframe+empty_moov, which ' +
                     'is what makes an mp4 writable to a socket at all'));

    const segTime = Number(settings.extraFormat.hls_time ||
                           settings.extraFormat.segment_time || 0);
    if (segTime > 0) {
        const gop = settings.gopSeconds || 2;
        if (gop > segTime + 0.01)
            out.push(caution(`segments are asked for every ${segTime} s and a keyframe every ` +
                             `${gop} s — a segment can only start on a keyframe, so they will come ` +
                             `out ${gop} s long. Set the keyframe interval to ${segTime} s or less.`));
    }
    return out;
}

function hardwareWarnings() {
    const out = [];
    const spec = currentSpec();
    const codec = activeVideoCodec();
    const device = deviceOfEncoder(codec);

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
        out.push(err(`this render leaves its picture on the card and ${codec} cannot take it ` +
                     'from there — pick a hardware encoder, or put an hwdownload after the ' +
                     'last hwupload'));
    else if (device && !endsUp && spec.filterGraph)
        out.push(caution(`${codec} runs on the ${device} and the picture is being made in system ` +
                         'memory, so every frame is copied up to it — an hwupload on the last wire ' +
                         'removes that copy'));

    const decoding = (spec.inputs || []).filter((i) => i.hwaccel).length;
    if (decoding)
        out.push(caution(`${decoding} input${decoding === 1 ? '' : 's'} decode on a card, which is ` +
                         'measured slower here than the CPU — see the note on Sources'));
    return out;
}

export function warnings() {
    const out = [];
    freshSpec();
    out.push(...destinationWarnings());

    out.push(...copyWarnings(settings.streams));

    if (needsGraph(currentSpec()) && !currentSpec().filterGraph) {
        const why = currentGraph() || {};
        const said = why.reason || 'the graph cannot be expressed for this edit';
        const generators = (currentSpec().clips || []).filter((c) => c && c.generator).length;
        const many = `${generators} generators on the timeline are`;
        out.push(generators
            ? err(`${generators === 1 ? 'a generator on the timeline is' : many} rendered by the ` +
                  `filter graph, and this render has none — ${said}`)
            : caution(`this render would go through the internal compositor without your ` +
                      `filters — ${said}`));
    }

    out.push(...padWarnings(settings.streams));

    out.push(...hardwareWarnings());

    if (settings.container === 'image2' && !bro.ffmpeg.hasFramePattern(settings.path) &&
        !settings.extraFormat.update && outputFrames() > 1)
        out.push(err(`${settings.path ? basename(settings.path) : 'the output'} has no frame ` +
                     'number in it, so every frame would be written over the one before — put ' +
                     '%04d in the name, or say One picture'));

    const draft = settings.streams.filter((s) => s.kind === 'attachment' && !s.path).length;
    if (draft)
        out.push(caution(`${draft} attachment${draft === 1 ? ' has' : 's have'} no file yet, so ` +
                         `${draft === 1 ? 'it' : 'they'} will not be written`));

    const atts = settings.streams.filter((s) => s.kind === 'attachment' && s.path).length;
    if (atts && settings.container !== 'matroska' && settings.container !== 'webm')
        out.push(err(`${settings.container} cannot hold an attachment — Matroska can`));
    const audioTracks = settings.streams.filter((s) => s.kind === 'audio').length;
    if (audioTracks > 1 && settings.container === 'webm')
        out.push(caution('WebM players commonly show only the first audio track'));

    out.push(...subtitleWarnings(settings.streams));

    for (const s of settings.streams) {
        if (!s.tag) continue;
        const known = codecTags(settings.container, codecOf(s));
        if (known.indexOf(s.tag) < 0)
            out.push(err(`the ${settings.container} muxer does not know '${s.tag}' as a tag for ` +
                         `${codecOf(s) || 'this codec'}, and will refuse the file`));
    }

    const c = muxerInfo(settings.container);
    const codec = activeVideoCodec();
    const info = encoderInfo(codec);
    const w = settings.width, h = settings.height;

    const wantsVideo = settings.streams.some((s) => s.kind === 'video' && !isCopy(s));
    const wantsAudio = settings.audio &&
                       settings.streams.some((s) => s.kind === 'audio' && !isCopy(s));
    if (c && wantsVideo && !c.videoCodecs.length)
        out.push(err(`no video encoder this build offers can go in ${c.name} — ` +
                     'take the video stream out on this stage, or pick another container'));
    else if (c && info && wantsVideo && c.videoCodecs.indexOf(codec) < 0)
        out.push(err(`${c.label} cannot hold ${info.label} — the muxer will refuse it`));
    if (c && wantsAudio && !c.audioCodecs.length)
        out.push(err(`no audio encoder this build offers can go in ${c.name} — ` +
                     'this render will be silent or be refused'));
    else if (c && wantsAudio && settings.audioCodec &&
             c.audioCodecs.indexOf(settings.audioCodec) < 0)
        out.push(err(`${c.label} cannot hold ${(audioInfo(settings.audioCodec) || {}).label}`));

    const pix = settings.pixelFormat || (info && info.pixelFormats[0]) || 'yuv420p';
    if (wantsVideo && /420/.test(pix) && ((w % 2) || (h % 2)))
        out.push(err(`${pix} needs even dimensions — ${w}×${h} will fail`));

    const canvasAspect = project.height ? project.width / project.height : 0;
    const outAspect = h ? w / h : 0;
    if (wantsVideo && canvasAspect && Math.abs(outAspect - canvasAspect) > 0.01)
        out.push(caution('the output is a different shape from the canvas — the picture will be stretched'));

    const fps = outputFps();
    if (wantsVideo && project.fps && fps > project.fps + 0.01)
        out.push(caution(`${fps} fps from a ${project.fps.toFixed(3)} fps timeline duplicates frames`));

    if (wantsVideo && info && info.hardware && settings.rate === 'quality')
        out.push(caution('a GPU encoder trades quality per bit for speed — compare it against x264 before trusting the number'));

    if (settings.rate === 'lossless')
        out.push(caution('lossless output is commonly ten to thirty times larger than CRF 20'));

    return out;
}
