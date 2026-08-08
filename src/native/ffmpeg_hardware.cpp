// The GPU, discovered rather than listed. See ffmpeg_hardware.h.

#include "ffmpeg_hardware.h"

#include "export_frame.h"       // avErr
#include "ffmpeg_report.h"      // LogQuiet

extern "C" {
#include <libavfilter/avfilter.h>
#include <libavutil/pixdesc.h>
}

#include <map>
#include <mutex>

namespace ffmpegbro {
namespace {

std::mutex& lock() {
    static std::mutex m;
    return m;
}

/// type|device → the shared context. Raw, and never freed: see the note at the
/// top of the header about tearing a CUDA context down after the driver has
/// started its own shutdown.
std::map<std::string, AVBufferRef*>& cache() {
    static std::map<std::string, AVBufferRef*> c;
    return c;
}

/// The filter-name suffix a device type uses.
///
/// It is the type's own name for every family but one — `scale_cuda`,
/// `scale_qsv`, `scale_vulkan`, `hwupload_cuda` — because that is the
/// convention libavfilter is written to. The exception is Direct3D, where the
/// *device* is `d3d11va` (the decoding API) and the *filters* are `_d3d11`
/// (the memory), and the two names are genuinely about different things.
std::string filterSuffix(const std::string& type) {
    if (type == "d3d11va") return "d3d11";
    return type;
}

/// What frames of this device type look like once a context exists.
///
/// Asked of the context rather than assumed: `av_hwframe_transfer_get_formats`
/// is about the software side, and the *hardware* format is what
/// `AVHWFramesConstraints::valid_hw_formats` reports — which is libavutil's own
/// answer and therefore the one that stays right when a type is added.
AVPixelFormat hwFormatOfDevice(AVBufferRef* device) {
    AVPixelFormat out = AV_PIX_FMT_NONE;
    AVHWFramesConstraints* c = av_hwdevice_get_hwframe_constraints(device, nullptr);
    if (c) {
        if (c->valid_hw_formats) out = c->valid_hw_formats[0];
        av_hwframe_constraints_free(&c);
    }
    return out;
}

/// How many indices to try before giving up on a type.
///
/// The walk below stops at the first refusal, so this is a guard rather than a
/// count: what decides how many devices there are is where libav starts saying
/// no. It exists for the type that would say yes to anything — nothing here
/// does, but a type added later might, and a probe that never returned would
/// be a startup hang blamed on whatever ran next.
constexpr int kMaxDevicesPerType = 16;

/// Which devices of this type this machine has, asked the only way libav
/// answers: by creating one of each index until it refuses.
///
/// **There is no count anywhere in libavutil.** `av_hwdevice_iterate_types`
/// walks the *types* the build was compiled with, which is the question
/// `probe()` already answers; there is no iterator over the devices of a type
/// and no `av_hwdevice_count`. What exists is `av_hwdevice_ctx_create`, which
/// takes the same string `-hwaccel_device` does and either makes a device or
/// does not. So this asks by failing, exactly as `present` does and behind the
/// same mute — a second card that is not there answers at AV_LOG_ERROR, and
/// that is a question the application put to itself rather than something a
/// render said.
///
/// **Every context is freed again**, which is the one place this file does not
/// keep what it makes. A CUDA primary context is a few hundred megabytes of a
/// card's memory; holding one on every card in the machine so that a picker
/// could be drawn would be spending a card nobody has chosen to use.
/// `hwDeviceRef` makes and caches the one a render is actually pointed at.
/// Measured on this machine (two RTX 4090s, driver 610.62): the whole probe
/// goes from 489 ms to 805 ms, and the 316 ms is where it looks — cuda's three
/// questions (0, 1, and the refusal at 2) are 126 ms, dxva2's 58, d3d11va's 53
/// and d3d12va's 41. It is asked once per process and only when something asks,
/// which is what makes that affordable; keeping the eight contexts instead
/// would have saved it and spent both cards.
///
/// **An empty list is an answer and not a failure.** A type whose devices are
/// not addressed by index — a VAAPI node is a path, an OpenCL device is
/// `platform.device` — refuses `"0"` and gets no list, and the control that
/// reads one falls back to the default device, which is what a machine with
/// one of anything wants anyway.
void fillDevices(HwDevice& d, AVHWDeviceType type) {
    for (int i = 0; i < kMaxDevicesPerType; ++i) {
        const std::string which = std::to_string(i);
        AVBufferRef* ref = nullptr;
        const int rc = av_hwdevice_ctx_create(&ref, type, which.c_str(), nullptr, 0);
        if (rc < 0 || !ref) {
            if (ref) av_buffer_unref(&ref);
            break;
        }
        av_buffer_unref(&ref);
        d.devices.push_back(which);
    }
}

void fillCodecs(HwDevice& d, AVHWDeviceType type) {
    void* it = nullptr;
    while (const AVCodec* c = av_codec_iterate(&it)) {
        if (!c->name) continue;
        if (av_codec_is_decoder(c)) {
            AVPixelFormat fmt = AV_PIX_FMT_NONE;
            if (decoderTakesDevice(c, type, &fmt)) {
                d.decoders.emplace_back(c->name);
                // The other place the frame format is written down, and for
                // several device types the only one. `dxva2` reports no frame
                // constraints at all until a decoder has been opened against
                // it, so `av_hwdevice_get_hwframe_constraints` answers nothing
                // — while every decoder that can use it has said `dxva2_vld` in
                // its own hardware configuration all along. Still libavcodec's
                // answer rather than a table; just a different question.
                if (d.pixelFormat == AV_PIX_FMT_NONE) d.pixelFormat = fmt;
            }
        } else if (av_codec_is_encoder(c)) {
            if (encoderDeviceType(c) == type) d.encoders.emplace_back(c->name);
        }
    }
}

void fillFilters(HwDevice& d) {
    const std::string suffix = "_" + filterSuffix(d.name);
    void* it = nullptr;
    while (const AVFilter* f = av_filter_iterate(&it)) {
        if (!f->name) continue;
        const std::string name = f->name;
        if (name.size() > suffix.size() &&
            name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0)
            d.filters.emplace_back(name);
    }
    // The two that belong to every device rather than to one, and that are the
    // whole of how a software graph reaches a hardware one.
    if (avfilter_get_by_name("hwupload")) d.filters.emplace_back("hwupload");
    if (avfilter_get_by_name("hwdownload")) d.filters.emplace_back("hwdownload");
}

std::vector<HwDevice> probe() {
    // **Behind a mute, for the reason `globPatternsSupported()` is.** This asks
    // by failing: every device type this build was compiled with and this
    // machine has no card for answers with an error, and on a machine with
    // NVIDIA cards `amf` answers `AMFQueryVersion failed with error 1` at
    // AV_LOG_ERROR. The channel is what a *render* said, and a render that went
    // perfectly would otherwise open its report drawer red over a question the
    // application put to itself before anybody pressed anything. What the
    // failure was is not lost — it is `HwDevice::error`, reported by
    // `bro.ffmpeg.hardware()`, which is where somebody asking about a card
    // looks.
    LogQuiet quiet;
    std::vector<HwDevice> out;
    AVHWDeviceType t = AV_HWDEVICE_TYPE_NONE;
    while ((t = av_hwdevice_iterate_types(t)) != AV_HWDEVICE_TYPE_NONE) {
        HwDevice d;
        const char* name = av_hwdevice_get_type_name(t);
        if (!name) continue;
        d.name = name;

        // **The measurement.** A type being compiled in says nothing about a
        // card being present, and the only way libav will answer the question
        // is to be asked for a device and to fail.
        AVBufferRef* ref = nullptr;
        const int rc = av_hwdevice_ctx_create(&ref, t, nullptr, nullptr, 0);
        if (rc < 0 || !ref) {
            d.error = avErr(rc);
            out.push_back(std::move(d));
            continue;
        }
        d.present = true;
        d.pixelFormat = hwFormatOfDevice(ref);
        fillDevices(d, t);
        fillCodecs(d, t);
        fillFilters(d);
        av_buffer_unref(&ref);
        out.push_back(std::move(d));
    }
    return out;
}

} // namespace

const std::vector<HwDevice>& hwDevices() {
    // Probed once. Creating every device type in turn is the better part of a
    // second on a machine with a driver for each of them, and it is a question
    // whose answer cannot change while this process runs.
    static const std::vector<HwDevice> devices = probe();
    return devices;
}

AVHWDeviceType hwTypeNamed(const std::string& name) {
    if (name.empty()) return AV_HWDEVICE_TYPE_NONE;
    return av_hwdevice_find_type_by_name(name.c_str());
}

bool isHwPixelFormat(AVPixelFormat fmt) {
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(fmt);
    return d && (d->flags & AV_PIX_FMT_FLAG_HWACCEL) != 0;
}

AVBufferRef* hwDeviceRef(const std::string& type, const std::string& device,
                         std::string* err) {
    const AVHWDeviceType t = hwTypeNamed(type);
    if (t == AV_HWDEVICE_TYPE_NONE) {
        if (err) *err = "this build has no hardware device called '" + type + "'";
        return nullptr;
    }

    const std::string key = type + "|" + device;
    std::lock_guard<std::mutex> g(lock());
    auto it = cache().find(key);
    if (it != cache().end()) return av_buffer_ref(it->second);

    AVBufferRef* made = nullptr;
    const int rc = av_hwdevice_ctx_create(&made, t, device.empty() ? nullptr : device.c_str(),
                                          nullptr, 0);
    if (rc < 0 || !made) {
        if (err)
            *err = "cannot open the " + type + " device" +
                   (device.empty() ? std::string() : " '" + device + "'") + ": " + avErr(rc);
        return nullptr;
    }
    cache()[key] = made;
    return av_buffer_ref(made);
}

bool isHardwareEncoder(const AVCodec* codec) {
    return codec && av_codec_is_encoder(codec) &&
           (codec->capabilities & AV_CODEC_CAP_HARDWARE) != 0;
}

AVHWDeviceType encoderDeviceType(const AVCodec* codec) {
    if (!codec || !av_codec_is_encoder(codec)) return AV_HWDEVICE_TYPE_NONE;
    for (int i = 0;; ++i) {
        const AVCodecHWConfig* c = avcodec_get_hw_config(codec, i);
        if (!c) break;
        if (c->methods & (AV_CODEC_HW_CONFIG_METHOD_HW_FRAMES_CTX |
                          AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX))
            return c->device_type;
    }
    return AV_HWDEVICE_TYPE_NONE;
}

bool decoderTakesDevice(const AVCodec* codec, AVHWDeviceType type, AVPixelFormat* fmt) {
    if (!codec || !av_codec_is_decoder(codec) || type == AV_HWDEVICE_TYPE_NONE) return false;
    for (int i = 0;; ++i) {
        const AVCodecHWConfig* c = avcodec_get_hw_config(codec, i);
        if (!c) break;
        if (c->device_type != type) continue;
        // `HW_DEVICE_CTX` is the hwaccel shape — the decoder is handed a device
        // and produces frames on it. `HW_FRAMES_CTX` is the same arrangement
        // where the caller supplies the pool, which the decoders that want it
        // will still set up themselves from a device. Either is usable through
        // `hw_device_ctx`; `INTERNAL` (the standalone `*_cuvid` decoders) is
        // not, because such a decoder takes the device through its own options
        // and does not go through `get_format` at all.
        if (!(c->methods & (AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX |
                            AV_CODEC_HW_CONFIG_METHOD_HW_FRAMES_CTX)))
            continue;
        if (fmt) *fmt = c->pix_fmt;
        return true;
    }
    return false;
}

const AVCodec* hwDecoderFor(AVCodecID id, AVHWDeviceType type, AVPixelFormat* fmt) {
    if (type == AV_HWDEVICE_TYPE_NONE || id == AV_CODEC_ID_NONE) return nullptr;

    // The ordinary decoder first: it is the one every other part of this binary
    // opens, and preferring it means a codec whose default decoder already
    // carries the configuration behaves exactly as it did.
    if (const AVCodec* def = avcodec_find_decoder(id))
        if (decoderTakesDevice(def, type, fmt)) return def;

    const AVCodec* best = nullptr;
    void* it = nullptr;
    while (const AVCodec* c = av_codec_iterate(&it)) {
        if (c->id != id || !av_codec_is_decoder(c)) continue;
        // `decoderTakesDevice` is what rules out the standalone `*_cuvid`
        // decoders: they take a device through their own options rather than
        // through `hw_device_ctx`, so a caller that set one would get a decoder
        // ignoring the device it was handed.
        if (decoderTakesDevice(c, type, fmt)) { best = c; break; }
    }
    return best;
}

} // namespace ffmpegbro
