// The renders that will succeed and be wrong.
//
// Everything here produces a file which is technically valid and practically
// not what was wanted, which is the failure worth catching. An encoder that
// refuses says so itself and needs no help from this.

import { project } from '../project.js';
import { settings, activeVideoCodec, outputFps } from './state.js';
import { encoderInfo, audioInfo, containerInfo } from './capabilities.js';
import { isEmpty as noUserNodes } from '../graph/overlay.js';
import { buildSpec } from './spec.js';

export function warnings() {
    const out = [];

    // The filters go through libavfilter, and the way they get there is
    // `spec.filterGraph`. If the derivation refused, the render still happens —
    // through the internal compositor, which cannot run a filter — so the file
    // would come out silently missing what was put on the graph. That is
    // exactly the outcome the lock rules exist to prevent, and it deserves to
    // be said in the same place as everything else that will succeed and be
    // wrong.
    if (!noUserNodes() && !buildSpec().filterGraph)
        out.push('your filters cannot be expressed as a graph for this edit, so this ' +
                 'render would go through the internal compositor without them');

    const c = containerInfo(settings.container);
    const codec = activeVideoCodec();
    const info = encoderInfo(codec);
    const w = settings.width, h = settings.height;

    if (c && info && c.videoCodecs.indexOf(codec) < 0)
        out.push(`${c.label} cannot hold ${info.label} — the muxer will refuse it`);
    if (c && settings.audio && settings.audioCodec && c.audioCodecs.indexOf(settings.audioCodec) < 0)
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
