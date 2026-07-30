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
//
// **The third thing is the rule itself, applied on a press.** Two decisions in two
// places is right, and it is also two controls in two places: `chooseFor()` at the
// bottom of the file takes the arrangement the measurement arrived at — software
// decode, hardware encode, above SD — and works out what *this* machine and *this*
// render make of it. It is a press and never automatic, and it names what it picked
// and why, because choosing on somebody's behalf without saying so is precisely the
// checkbox this file exists instead of.

import { updateInput } from './inputs.js';

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

/// **Which devices of this type there are**, by the string `-hwaccel_device`
/// takes: `['0', '1']` on a machine with two cards.
///
/// A different question from `present()`, and the one that was never asked. A
/// type is present when *a* device of it could be created; how many there are
/// has no answer in libavutil at all, so the native half asks by creating one
/// of each index until it refuses — see `fillDevices` in ffmpeg_hardware.cpp.
/// Until that existed, "which one" was a text box: `-hwaccel_device 1` has been
/// settable since inputs grew a device, and nothing here could say whether the
/// 1 addressed anything.
///
/// **Empty means "cannot say", not "none".** A type whose devices are not
/// indices — a VAAPI node is a path — answers with nothing, and a control
/// reading this must then fall back to the default device rather than conclude
/// the machine has no cards.
export function deviceIndices(name) {
    const d = deviceNamed(name);
    return (d && d.devices) || [];
}

/// Is this an `-hwaccel_device` that this machine cannot honour?
///
/// The case that matters is a **document**: an edit written on the machine with
/// two cards, opened on the laptop with one, carrying `-hwaccel_device 1` on an
/// input. Snapping it quietly to the default would be a render pointed at a
/// different card from the one the document says, which is the sort of silent
/// disagreement this application refuses everywhere else — so the value is kept,
/// shown, and said to be absent. libav refuses it at the open either way; this
/// is so that the refusal is visible before the render rather than after it.
///
/// False for an empty string (the default device is always addressable) and
/// false when the type reports no indices at all, because "cannot say" is not
/// evidence of absence.
export function unknownDeviceIndex(name, which) {
    const value = String(which || '').trim();
    if (!value) return false;
    const list = deviceIndices(name);
    if (!list.length) return false;
    return list.indexOf(value) < 0;
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

// ── choosing, on a press ───────────────────────────────────────────────────
//
// Everything above is a control saying what a decision costs. This is the
// decision, taken on request, and it exists because the two sentences above are
// the whole of an answer that nobody should have to assemble by hand: the
// measurement in docs/manual/card.md says **software decode, hardware encode,
// above SD**, and until now the only way to arrive at that arrangement was to read
// both sentences, walk to two stages and set three controls.
//
// **A press, and never automatic.** A machine that quietly rewrote somebody's
// encoder when they opened a file would be the "use hardware acceleration"
// checkbox this application exists without, one step further on: it would be
// making the choice *and* not saying so. So it is asked for, and what it produces
// is a sentence naming the encoder it picked and the reason it picked it. That
// sentence is not a nicety — "choosing on somebody's behalf and then having to say
// so" is the entire cost of the feature, and it is paid here.
//
// **It asks the machine and never a list.** Which encoders exist on a card here is
// `bro.ffmpeg.hardware()`'s answer, cut down to the ones this build actually
// carries by `bro.ffmpeg.encoders`; a vcpkg ffmpeg has every NVENC, AMF and QSV
// encoder in it on a machine with no card at all, which is the exact failure
// `firstOnACard` in ui/export/presets.js was written against. Nothing here names a
// device or an encoder. The only preference expressed is *which* of several to
// reach for, and even that is derived: the same codec as the one already chosen,
// so a press does not also change what will play on the other end.

let encoderCache = null;

/// Every video encoder this build carries, by name, with the codec it encodes.
///
/// `codecName` is libavcodec's own — `avcodec_get_name(codec->id)` — which is what
/// makes "the same codec family" a question with an answer rather than a table of
/// name prefixes here. `libx264` and `h264_nvenc` both answer `h264`.
function encoders() {
    if (encoderCache) return encoderCache;
    try {
        encoderCache = (bro.ffmpeg.encoders || []).map(
            (e) => ({ id: e.id, label: e.label || e.id, codec: e.codecName || '' }));
    } catch (e) {
        encoderCache = [];
    }
    return encoderCache;
}

const encoderNamed = (id) => encoders().find((e) => e.id === id) || null;

/// Where the card stops paying. Above this a hardware encoder is worth two to
/// three times; below it, it loses outright.
///
/// **576 because that is the top of standard definition**, and not because
/// anything was measured at 576. The measurement has 640×360 at 0.6× and 1920×1080
/// at 2.2×, so the crossing is somewhere in between and no number in that gap is
/// more honest than another — drawing the line at a name everybody already agrees
/// on is better than inventing a threshold from two points. See docs/manual/card.md
/// for the tables; if a build ever measures the gap, this is the one place it
/// changes.
export const SD_LINES = 576;

/// The rule, applied to one render. **Decides and says why; writes nothing.**
///
/// Pure because the saying is half of the point: a function that quietly mutated
/// the settings could not hand back a sentence to put on the screen, and the press
/// would be the silent switch this whole file exists instead of. `applyChoice()`
/// below is the other half, and it is deliberately a second call.
///
/// `render` is `{ height, videoCodec, inputs }` — the output's own height, because
/// a render of a 4K source at 640×360 is a 640×360 encode and the encoder is the
/// only thing being decided; the encoder in force, so the answer can stay in its
/// codec family; and the inputs, because the decode half of the rule is theirs.
///
/// Returns `{ encoder, device, decodes, why, changed }`. `encoder` is '' for
/// "leave it alone", which is a real answer and not a failure — it is what a
/// render already arranged correctly gets.
export function chooseFor(render) {
    const r = render || {};
    const lines = Math.max(0, Math.round(Number(r.height) || 0));
    const current = String(r.videoCodec || '');
    // Software decode, which is the half of the rule that has no exceptions: the
    // decode is two to six times slower on the card here whether or not the
    // picture comes back down, so every input that is on one comes off it.
    const decodes = (r.inputs || []).filter((i) => i && i.hwaccel);
    const family = (encoderNamed(current) || {}).codec || '';
    const onCard = isHardwareEncoder(current);

    if (!lines)
        return answer('', decodes,
            'The render has no size yet, so there is nothing to decide about the encoder. ' +
            (decodes.length ? decodeSentence(decodes) : 'Nothing to change.'));

    if (lines > SD_LINES) {
        const pick = hardwareChoices(family)[0];
        if (!pick)
            return answer('', decodes,
                `This machine has no encoder that runs on a device — ${
                    present().length ? `${present().map((d) => d.name).join(', ')} ${
                        present().length === 1 ? 'works' : 'work'} here but ${
                        present().length === 1 ? 'reports' : 'report'} no encoder this build ` +
                        'carries'
                                     : 'no device type could be created at all'
                }. So there is nothing to choose, and ${current || 'the encoder in force'} ` +
                `stays. ` + (decodes.length ? decodeSentence(decodes)
                                            : 'The decode is already on the CPU, which is where ' +
                                              'the measurement wants it.'));
        if (onCard)
            return answer('', decodes,
                `${current} already runs on ${deviceOfEncoder(current) || 'a device'}, which is ` +
                `the right half to put there at ${lines} lines. ` +
                (decodes.length ? decodeSentence(decodes)
                                : 'And the decode is already on the CPU. Nothing to change.'));
        return answer(pick.id, decodes,
            `${pick.label} on ${pick.device}, because ${lines} lines is above SD and the card ` +
            `is worth two to three times there — measured, in docs/manual/card.md${
                family ? `. Same codec as ${current}, so what will play on the other end ` +
                         'has not changed' : ''}. ` +
            (decodes.length ? decodeSentence(decodes)
                            : 'The decode stays on the CPU, where it is several times faster.'));
    }

    // At or below SD the card loses outright — a small frame is all fixed cost and
    // a GPU round trip is mostly fixed cost — so this is the one direction of the
    // press that takes an encoder *off* a device.
    if (onCard) {
        const soft = softwareChoices(family)[0];
        if (!soft)
            return answer('', decodes,
                `${lines} lines is at or below SD, where the card loses outright — but this ` +
                `build has no encoder for ${family || 'this codec'} that does not run on one, ` +
                `so ${current} stays. ` + (decodes.length ? decodeSentence(decodes) : ''));
        return answer(soft.id, decodes,
            `${soft.label}, because ${lines} lines is at or below SD and ${current} is slower ` +
            `than the CPU there — a small frame is all fixed cost and a device round trip is ` +
            `mostly fixed cost. ` +
            (decodes.length ? decodeSentence(decodes)
                            : 'The decode is on the CPU already.'));
    }
    return answer('', decodes,
        `${current || 'The encoder in force'} is already the answer at ${lines} lines: at or ` +
        'below SD a device encode is slower than the CPU, so there is nothing to move onto one. ' +
        (decodes.length ? decodeSentence(decodes) : 'And the decode is on the CPU. Nothing to change.'));
}

function answer(encoder, decodes, why) {
    const same = !encoder;
    return {
        encoder,
        device: encoder ? deviceOfEncoder(encoder) : '',
        decodes,
        why,
        changed: !same || decodes.length > 0,
    };
}

function decodeSentence(decodes) {
    const names = decodes.map((i) => i.name).join(', ');
    return `${decodes.length === 1 ? `${names} is` : `${names} are`} decoding on a device and ` +
           `${decodes.length === 1 ? 'goes' : 'go'} back to the CPU: the decode is measured two ` +
           'to six times slower there, and the readback everybody blames is 3% of it.';
}

/// The encoders on a working device that this build also carries, best first.
///
/// "Best" is the one preference in the whole rule and it is derived rather than
/// listed: an encoder of the same codec as the one already chosen comes first, so
/// a press changes where the encoding happens and not what will play on the other
/// end. Beyond that the order is `bro.ffmpeg.encoders`' own, which is the native
/// side's candidate order and already the documented home for "which to reach for
/// first" — see `firstOnACard` in ui/export/presets.js, which states the same rule
/// for the GPU preset.
export function hardwareChoices(family) {
    const here = new Set();
    for (const d of present()) for (const e of d.encoders || []) here.add(e);
    const out = encoders().filter((e) => here.has(e.id))
                          .map((e) => Object.assign({}, e, { device: deviceOfEncoder(e.id) }));
    if (!family) return out;
    return out.filter((e) => e.codec === family).concat(out.filter((e) => e.codec !== family));
}

/// And the same question the other way: what encodes this codec *without* a
/// device. Asked of the device lists rather than of the name, for the reason
/// `isHardwareEncoder` gives.
export function softwareChoices(family) {
    return encoders().filter((e) => !isHardwareEncoder(e.id) &&
                                    (!family || e.codec === family));
}

/// Write a choice's decode half: every input it named comes off its device.
///
/// A second call rather than part of `chooseFor()`, so that deciding and doing are
/// separable — a caller can put the sentence on the screen without having changed
/// anything, which is what the button's title does before it is pressed.
///
/// The **encoder** half is deliberately not here: `settings.videoCodec` belongs to
/// `ui/export/state.js` and writing it means `clampToEncoder()` and a redraw, which
/// is the Encode stage's business and not this file's. This module knows about
/// devices and nothing about what the Encode stage is set to.
///
/// Returns the inputs whose opening actually changed, which is what a caller has to
/// reload: `-hwaccel_output_format` goes with the device that named it, because left
/// behind it is a pixel format belonging to a device this input no longer decodes
/// on — the same pairing the Sources picker makes, for the same reason.
export function applyChoice(choice) {
    const moved = [];
    for (const input of (choice && choice.decodes) || []) {
        if (updateInput(input, { hwaccel: '', hwaccelDevice: '', hwaccelOutputFormat: '' }))
            moved.push(input);
    }
    return moved;
}
