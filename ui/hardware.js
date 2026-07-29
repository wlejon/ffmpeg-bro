// The GPU, and an honest account of when it helps.
//
// `bro.ffmpeg.hwaccels` is a list of names and always has been. It is a fact
// about the *build*: every device type a vcpkg ffmpeg is compiled with is in
// it, on every machine, whether or not there is a card. Offering that list as
// a menu would be offering four things that fail at the last step.
//
// `bro.ffmpeg.hardware()` is the measurement — each type has a device created
// of it and reports whether that worked, what pixel format its frames are in,
// which decoders can use it, which encoders take its frames and which filters
// belong to it. Everything on the screen comes from there, so a control cannot
// offer something this machine does not have.
//
// **The second thing this file holds is the cost, in a sentence, where the
// choice is made.** ffmpeg-bro's culture is to measure, and the measurement
// (tests/hardware_test.cpp; the tables are in docs/manual/card.md) says
// something that most software with a "use hardware acceleration" checkbox
// does not say: on this hardware a hardware *decode* is a loss, several times
// over, and the readback everybody blames is 3–4% of it. The win is entirely
// the encoder. A control that offered both as one switch labelled "hardware"
// would be wrong about half of what it does, so they are two decisions in two
// places — decoding is per input on Sources, encoding is per stream on Write —
// and the one that is usually a mistake says so beside itself.

let cached = null;

/// Every device type, with this machine's answer about it. Asked once: creating
/// a device of every type is the better part of a second, and the native half
/// caches it too, so this is about not paying for the JS round trip on every
/// redraw rather than about the probe.
export function devices() {
    if (cached) return cached;
    try {
        cached = bro.ffmpeg.hardware() || [];
    } catch (e) {
        cached = [];
    }
    return cached;
}

/// The ones that work here. This is the list a picker is built from — never
/// `bro.ffmpeg.hwaccels`, which answers about the build.
export function present() {
    return devices().filter((d) => d.present);
}

export function deviceNamed(name) {
    return devices().find((d) => d.name === name) || null;
}

/// Can this device decode this codec, in this build?
///
/// The question people are surprised by, and the one that makes a hardware
/// decode fail on a machine with a working card: two RTX 4090s still have no
/// CUDA ProRes decoder. The list comes from libavcodec's own hardware
/// configurations, per codec, so there is no table here.
export function decodes(device, codecName) {
    if (!device || !codecName) return false;
    return (device.decoders || []).indexOf(codecName) >= 0;
}

/// Which device types can decode this input, given what it probed as.
export function devicesFor(input) {
    const codec = input && input.probe && input.probe.video && input.probe.video.codec;
    if (!codec) return present();
    return present().filter((d) => decodes(d, codec));
}

/// Is this encoder one that runs on a device? Asked of the device lists rather
/// than of the name, because `h264_nvenc` and `h264_amf` and `h264_qsv` are
/// three vocabularies and a suffix test would be a fourth.
export function isHardwareEncoder(name) {
    if (!name) return false;
    return devices().some((d) => (d.encoders || []).indexOf(name) >= 0);
}

/// The device an encoder runs on, or ''.
export function deviceOfEncoder(name) {
    const d = devices().find((x) => (x.encoders || []).indexOf(name) >= 0);
    return d ? d.name : '';
}

/// The filter-name suffix a device's family uses. libavfilter's own convention
/// — `scale_cuda`, `scale_qsv`, `scale_vulkan` — with the one exception where
/// the device is the decoding API (`d3d11va`) and the filters are the memory
/// (`_d3d11`), which are genuinely different things.
export function filterSuffix(name) {
    return name === 'd3d11va' ? 'd3d11' : name;
}

/// Does this filter run on a device, and if so which?
///
/// Read off the device's own filter list, which was built by walking
/// libavfilter — so a build with one more `_vulkan` filter needs no edit here.
/// `hwupload` and `hwdownload` belong to every device and are excluded: they are
/// the *crossing*, and saying they are on one device would be saying the wrong
/// half of what they do.
export function deviceOfFilter(name) {
    if (!name || name === 'hwupload' || name === 'hwdownload') return '';
    const d = devices().find((x) => (x.filters || []).indexOf(name) >= 0);
    return d ? d.name : '';
}

/// True for the two filters that move a picture between system memory and a
/// device. They are what makes a software decode reach a hardware encoder,
/// which on this machine is the arrangement that wins.
export function isCrossing(name) {
    return name === 'hwupload' || name === 'hwdownload' ||
           /^hwupload_/.test(String(name || ''));
}

/// Which device a render's filters should be given.
///
/// `-filter_hw_device`, and it is derived rather than asked for. `hwupload`
/// takes no argument that could name a device and libavfilter's answer is the
/// graph's, so *something* has to decide — and there are only two things in a
/// render that name a device: an input that decodes on one, and a filter that
/// belongs to one. Taking the first of those that says anything is what makes
/// dropping an `hwupload` on the graph work without a second control somewhere
/// else that has to be found and set to agree with it.
///
/// A render whose inputs and filters name *different* devices is a render that
/// cannot work, and it is `check.js` that says so rather than this: this picks
/// one, and picking is not the place to complain.
export function deviceForRender(graphText, inputList) {
    for (const i of inputList || []) if (i.hwaccel) return i.hwaccel;
    const text = String(graphText || '');
    for (const d of present()) {
        const suffix = '_' + filterSuffix(d.name);
        // The filter names in the text, matched against the ones this device
        // reported. A substring test on the suffix alone would match `hwupload`
        // in a graph with no device filter in it at all.
        for (const f of d.filters || []) {
            if (f === 'hwupload' || f === 'hwdownload') continue;
            if (!f.endsWith(suffix)) continue;
            if (new RegExp('(^|[,;\\[\\]\\s])' + f + '([=,;\\[\\s]|$)').test(text)) return d.name;
        }
    }
    // A graph with an `hwupload` in it and nothing that says where to. One
    // working device is not a guess; several is, and the first is as good an
    // answer as any control that had never been touched would give.
    if (/(^|[,;\]\s])hwupload(_[a-z0-9]+)?([=,;\[\s]|$)/.test(text)) {
        const first = present()[0];
        return first ? first.name : '';
    }
    return '';
}

/// What this machine will do with a hardware decode, in a sentence, for the
/// control that is about to be used.
///
/// **This is the whole reason the module has an opinion.** The measurement is
/// in docs/manual/card.md and it is unambiguous: decoding on the card is
/// slower than libavcodec threaded across every core, and it is slower
/// whether or not the picture comes back down. A checkbox that said nothing
/// would be read as an optimisation.
export const decodeCost =
    'Measured slower here than the CPU — libavcodec decodes threaded across ' +
    'every core, and one NVDEC stream pulled a frame at a time is several ' +
    'times that. The readback is not the reason; the decode is.';

/// And what it will do with a hardware encode, which is the opposite answer.
export const encodeCost =
    'Several times faster than x264 above SD, and slower below it. It is the ' +
    'encoder that makes a card worth having here, not the decoder.';
