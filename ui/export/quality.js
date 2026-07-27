// What the settings cost, as a number.
//
// The A/B stage already renders the same seconds twice — once at the chosen
// settings, once losslessly — and lays one over the other with a wipe. Which is
// exactly a *reference* and a *distorted* input, the two things every objective
// quality metric is defined on, sitting on disk with nothing else to do. So the
// comparison you have been judging by eye becomes `psnr`, `ssim` and, where the
// build has it, `libvmaf`.
//
// That is worth saying plainly because it is the strongest thing in this chunk:
// "how much does CRF 23 cost me over CRF 20" stops being a matter of staring at
// grass and becomes 41.8 dB against 43.6 dB. It is also the honest version —
// the numbers are measured on the very files the wipe is showing, so they
// cannot describe a different render.
//
// Four decisions about how it is done:
//
// **It is a third render through the same one slot**, chained after the
// candidate the way the candidate is chained after the reference. There is no
// separate measuring path, for the reason the node previews have none, and no
// second job slot — the host has one and everything queues behind an export.
//
// **It writes nothing.** `-f null -` with `wrapped_avframe`: what is wanted is
// the metadata `psnr` and `ssim` hang on every frame they pass, and the
// pictures are already on disk twice over. That is the same `discard` an
// analysis pass uses, spelt out here because this is one render rather than a
// pass of one.
//
// **The formats are libavfilter's business.** The reference is yuv444p and the
// candidate is whatever the encoder settled on; `psnr` declares one format list
// across both its inputs, so libavfilter negotiates and inserts the conversion
// itself. Doing it by hand here would be a second opinion about a question the
// library already answers, and a wrong one the first time somebody renders 10-bit.
//
// **The answers arrive through the report**, as ordinary series — the same
// channel `cropdetect` uses, keyed by libavfilter's own metadata names. So the
// number under the wipe and the per-frame line in the Report drawer are the
// same measurement, and the frame where the encode fell apart is a place you
// can point at.

import * as report from '../report.js';
import { infoOf } from '../graph/filters.js';
import { settings, preview, outputFps } from './state.js';

/// Which metrics this build can compute. Asked of libavfilter rather than
/// written down: `psnr` and `ssim` are in every build, `libvmaf` is a
/// `--enable-libvmaf` and most are not, and a row promising a number that never
/// arrives is worse than a row that is not there.
export function metrics() {
    return [
        { id: 'psnr', filter: 'psnr', label: 'PSNR', key: 'lavfi.psnr.psnr_avg',
          unit: ' dB', decimals: 2,
          hint: 'peak signal-to-noise ratio over the whole preview — higher is closer to ' +
                'the lossless reference; above about 40 dB the difference is hard to see' },
        { id: 'ssim', filter: 'ssim', label: 'SSIM', key: 'lavfi.ssim.All',
          unit: '', decimals: 4,
          hint: 'structural similarity, 0 to 1 — what survived of the picture’s structure ' +
                'rather than of its exact values' },
        { id: 'vmaf', filter: 'libvmaf', label: 'VMAF', key: 'lavfi.vmaf.score',
          unit: '', decimals: 1,
          hint: 'Netflix’s perceptual score, 0 to 100 — the one of the three that was ' +
                'trained on what people actually notice' },
    ].filter((m) => !!infoOf(m.filter));
}

/// Can this comparison be made at all?
///
/// Both files have to exist and there has to be at least one metric. Said as a
/// reason rather than as a missing panel: a build without any of the three is a
/// real state and "nothing here" would read as a bug.
export function why() {
    if (!metrics().length)
        return 'this build of libavfilter has no psnr, ssim or libvmaf in it, so there is ' +
               'nothing to measure the two halves with';
    if (!preview.refReady || !preview.candReady)
        return 'render both halves and they can be compared as a number as well as by eye';
    return '';
}

/// The graph that measures one against the other.
///
/// `[0:v]` is the candidate and `[1:v]` is the reference, which is the order
/// every one of these filters expects: the first input is the picture being
/// judged and the second is the truth. Each metric passes its first input
/// through unchanged, so they chain — the distorted frames go in at the top and
/// come out at the bottom having been compared once per metric on the way.
export function qualityGraph() {
    const list = metrics();
    if (!list.length) return null;

    const chains = [];
    // `settb` and `setpts` because every one of these filters pairs its two
    // inputs by timestamp: two files written by the same render at the same
    // rate agree, and saying so costs nothing next to finding out that they did
    // not on somebody's variable-frame-rate source.
    chains.push('[0:v]settb=AVTB,setpts=PTS-STARTPTS[dist]');
    const refs = list.map((m, i) => `[ref${i}]`);
    chains.push(`[1:v]settb=AVTB,setpts=PTS-STARTPTS` +
                (list.length > 1 ? `,split=${list.length}` : '') +
                `${refs.join('')}`);
    let carry = '[dist]';
    list.forEach((m, i) => {
        const out = i === list.length - 1 ? '[vout]' : `[m${i}]`;
        chains.push(`${carry}${refs[i]}${m.filter}${out}`);
        carry = out;
    });
    return {
        filterGraph: chains.join(';'),
        filterInputs: [
            { label: '0:v', path: preview.candPath, stream: 'v', from: 0 },
            { label: '1:v', path: preview.refPath, stream: 'v', from: 0 },
        ],
    };
}

/// The spec for that render. Writes nothing, encodes nothing, and asks the
/// graph how big the picture is rather than telling it — the two files are
/// already the size they are.
export function qualitySpec(range) {
    const g = qualityGraph();
    if (!g) return null;
    return {
        path: bro.ffmpeg.tempPath('quality.null'),
        format: 'null',
        videoCodec: 'wrapped_avframe',
        audio: false,
        width: settings.width, height: settings.height,
        fps: outputFps(),
        start: 0,
        end: Math.max(0.05, range.end - range.start),
        sizeFromGraph: true,
        filterGraph: g.filterGraph,
        filterInputs: g.filterInputs,
    };
}

/// What the last comparison found, read out of the channel the render measured
/// into. Nothing is stored twice: the numbers live in the report as series and
/// this is a reading of them.
export function qualityResult(job) {
    const out = [];
    for (const m of metrics()) {
        const s = report.seriesFor(m.key);
        if (!s || !s.points.length) continue;
        if (job && s.job !== job) continue;
        // The last value, because every one of these filters accumulates: the
        // metadata on the final frame is the figure for the whole comparison,
        // which is also what the filter prints at end of input.
        let v = null;
        for (let i = s.points.length - 1; i >= 0 && v === null; i--)
            if (Number.isFinite(s.points[i].v)) v = s.points[i].v;
        if (v === null) continue;
        out.push({ id: m.id, label: m.label, key: m.key, unit: m.unit,
                   hint: m.hint, value: v,
                   text: `${v.toFixed(m.decimals)}${m.unit}` });
    }
    return out;
}
