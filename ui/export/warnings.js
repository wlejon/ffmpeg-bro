// The renders that will succeed and be wrong.
//
// Everything here produces a file which is technically valid and practically
// not what was wanted, which is the failure worth catching. An encoder that
// refuses says so itself and needs no help from this.

import { project } from '../project.js';
import { basename } from '../format.js';
import { settings, activeVideoCodec, outputFps } from './state.js';
import { encoderInfo, audioInfo, muxerInfo, codecTags } from './capabilities.js';
import { codecOf } from './streams.js';
import { isEmpty as noUserNodes, current as overlayState } from '../graph/overlay.js';
import { renderGraph } from '../filtergraph.js';
import { buildSpec, range, specSources } from './spec.js';

/// How many frames this render will write. A single-frame range written into
/// one picture is exactly what somebody means by "a still of this moment";
/// the same path over a hundred frames is not.
function outputFrames() {
    return Math.max(0, Math.round(range().length * outputFps()));
}

export function warnings() {
    const out = [];

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
    const wantsVideo = settings.streams.some((s) => s.kind === 'video');
    const wantsAudio = settings.audio && settings.streams.some((s) => s.kind === 'audio');
    if (c && wantsVideo && !c.videoCodecs.length)
        out.push(`no video encoder this build offers can go in ${c.name} — ` +
                 'take the video stream out on this stage, or pick another container');
    else if (c && info && c.videoCodecs.indexOf(codec) < 0)
        out.push(`${c.label} cannot hold ${info.label} — the muxer will refuse it`);
    if (c && wantsAudio && !c.audioCodecs.length)
        out.push(`no audio encoder this build offers can go in ${c.name} — ` +
                 'this render will be silent or be refused');
    else if (c && settings.audio && settings.audioCodec &&
             c.audioCodecs.indexOf(settings.audioCodec) < 0)
        out.push(`${c.label} cannot hold ${(audioInfo(settings.audioCodec) || {}).label}`);

    const pix = settings.pixelFormat || (info && info.pixelFormats[0]) || 'yuv420p';
    if (/420/.test(pix) && ((w % 2) || (h % 2)))
        out.push(`${pix} needs even dimensions — ${w}×${h} will fail`);

    const canvasAspect = project.height ? project.width / project.height : 0;
    const outAspect = h ? w / h : 0;
    if (canvasAspect && Math.abs(outAspect - canvasAspect) > 0.01)
        out.push('the output is a different shape from the canvas — the picture will be stretched');

    const fps = outputFps();
    if (project.fps && fps > project.fps + 0.01)
        out.push(`${fps} fps from a ${project.fps.toFixed(3)} fps timeline duplicates frames`);

    if (info && info.hardware && settings.rate === 'quality')
        out.push('a GPU encoder trades quality per bit for speed — compare it against x264 before trusting the number');

    if (settings.rate === 'lossless')
        out.push('lossless output is commonly ten to thirty times larger than CRF 20');

    return out;
}
