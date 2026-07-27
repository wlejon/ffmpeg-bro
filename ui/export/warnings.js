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
import { isEmpty as noUserNodes, current as overlayState } from '../graph/overlay.js';
import { renderGraph } from '../filtergraph.js';
import { buildSpec, range, specSources } from './spec.js';

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

export function warnings() {
    const out = [];
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

    if (!noUserNodes() && !buildSpec().filterGraph) {
        const why = renderGraph(buildSpec(), specSources(), { overlay: overlayState() });
        out.push(`this render would go through the internal compositor without your ` +
                 `filters — ${why.reason || 'the graph cannot be expressed for this edit'}`);
    }

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
