// The GPU: what this machine actually has, and the one place a device is made.
//
// `bro.ffmpeg.hwaccels` has reported what this *build* could use since the
// first commit and nothing ever selected one. The gap between those two facts
// is the whole of this file: `av_hwdevice_iterate_types` answers about the
// build — cuda, qsv, d3d11va, dxva2, vulkan, opencl are compiled in whether or
// not a card is present — and the only way to find out whether a type works is
// to create a device of it and see. So that is what `hwDevices()` does. It is
// the one query in this binary that is a *measurement* rather than a
// registry walk, which is why it is cached and why it is not run at startup.
//
// **Three things are decided here and nowhere else.**
//
//   - **A device is made once and shared.** `av_hwdevice_ctx_create` on CUDA is
//     tens of milliseconds and allocates a context on the card; a render with
//     four inputs and a filter graph would make six of them. `hwDeviceRef`
//     hands back a new reference to a cached one, keyed by type and by the
//     device string, so `-hwaccel_device 0` and `-hwaccel_device 1` are two
//     devices and two of the same are one.
//   - **A hardware path that is unavailable refuses, and says why.** It never
//     falls back silently. This binary's standing rule is that a render must
//     not succeed while ignoring what it was told, and "I decoded it in
//     software after all" is exactly that — it is also, on this machine, a
//     *faster* render than the one that was asked for, which makes a silent
//     fallback impossible to notice. Where a fallback genuinely is the right
//     answer the caller does it explicitly and says so on the report channel.
//   - **How many there are is the same measurement one level down.** A type
//     being present says a card answered, not how many did, and libavutil has
//     no count and no iterator over the devices of a type — only
//     `av_hwdevice_ctx_create` taking the string `-hwaccel_device` takes. So
//     `HwDevice::devices` is that call per index until it refuses. Without it
//     "which one" is a number typed into a box that this binary cannot say
//     addresses anything, which is what it was.
//   - **Nothing is tabled.** Which decoders can use a device, which encoders
//     take its frames and what pixel format its frames are in are all asked of
//     libavcodec — `avcodec_get_hw_config` walks each codec's own list, and a
//     build with one more of them needs no edit here.
//
// The cached device contexts are deliberately never freed. A `static` holding
// an `AVBufferRef*` that unrefs at exit would tear a CUDA context down after
// the driver has begun its own shutdown, and **a shutdown that frees a service
// before the objects that call into it fails silently and blames whatever ran
// last**. That general shape cost this repository an afternoon once already,
// from the other side: bro's `~Engine` reset `audioEngine_` before `document_`,
// `~ElVideo` calls `closeStream` on it through a non-owning pointer, and any
// document that had played sound corrupted the heap at exit — which surfaced
// as the headless binary here dying after every check had passed. The symptom
// is the same either way: a crash on the way out, with nothing wrong at the
// place it is reported. A process-lifetime device costs one context and ends
// when the process does.
#pragma once

#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/buffer.h>
#include <libavutil/hwcontext.h>
#include <libavutil/pixfmt.h>
}

namespace ffmpegbro {

/// One hardware device type, as this machine answered for it.
struct HwDevice {
    /// The name `-hwaccel` takes: "cuda", "qsv", "d3d11va", "vulkan".
    std::string name;

    /// **Whether a device of this type could actually be created.** The
    /// difference between this and being in `hwaccels` is the whole point:
    /// every type in a vcpkg ffmpeg is compiled in, and on a machine with an
    /// AMD card `cuda` is compiled in and absent.
    bool present = false;

    /// Why not, in libav's own words, when `present` is false.
    std::string error;

    /// **Every device of this type this machine has**, as the string
    /// `-hwaccel_device` and `-filter_hw_device cuda:1` take: "0", "1", …
    ///
    /// `HwDevice` is a *type* — the thing `av_hwdevice_iterate_types` walks —
    /// and until this existed the only device of it anybody could name was the
    /// default one. That is what made "which one" a text box: `-hwaccel_device`
    /// has always been settable, and nothing in this binary knew whether the
    /// number typed into it addressed anything. Enumerated by creating one of
    /// each index until libav refuses (`fillDevices`), because there is no
    /// count in libavutil to ask for.
    ///
    /// Empty for a `present` type whose devices are not indices — a VAAPI node
    /// is a path — which leaves the default device as the only one that can be
    /// named, which is what it already was.
    std::vector<std::string> devices;

    /// The pixel format frames of this device live in — `cuda`, `qsv`,
    /// `d3d11`. `AV_PIX_FMT_NONE` when nothing could be created.
    AVPixelFormat pixelFormat = AV_PIX_FMT_NONE;

    /// The decoders in this build that can be pointed at a device of this type,
    /// by the name `avcodec_find_decoder_by_name` takes. Read off each codec's
    /// own `avcodec_get_hw_config` list, so it is what libavcodec says rather
    /// than what anybody wrote down.
    std::vector<std::string> decoders;

    /// The encoders that take this device's frames directly — `h264_nvenc`,
    /// `hevc_qsv`. A render whose graph ends on the card and whose encoder is
    /// one of these never brings a picture down.
    std::vector<std::string> encoders;

    /// The filters in this build whose names end `_cuda`, `_qsv`, `_vulkan`,
    /// `_opencl` … for this type, plus `hwupload`/`hwdownload`. Used by the
    /// graph palette so that "what can I put on a hardware wire" is answered by
    /// libavfilter and not by a list.
    std::vector<std::string> filters;
};

/// Every hardware device type this build has, each with an honest answer about
/// whether it works here. Probed once, on the first call; the answer cannot
/// change while the process runs without a driver being reinstalled underneath
/// it, and probing is not free.
const std::vector<HwDevice>& hwDevices();

/// A reference to the shared device context for `type` (and `device`, which is
/// `-hwaccel_device`: an index for CUDA, an adapter for D3D11, a path for VAAPI;
/// empty is the default one).
///
/// The caller owns the returned reference and unrefs it; the context behind it
/// is shared and outlives every reference to it. Null with `*err` set when this
/// machine has no such device — see the note at the top about why that is a
/// refusal rather than a fallback.
AVBufferRef* hwDeviceRef(const std::string& type, const std::string& device,
                         std::string* err);

/// True when this codec is a hardware encoder — `AV_CODEC_CAP_HARDWARE`, asked
/// of libavcodec. The UI marks them, and the writer checks one before opening
/// an encoder against a frames context.
bool isHardwareEncoder(const AVCodec* codec);

/// The device type a hardware encoder wants its frames from, or
/// `AV_HWDEVICE_TYPE_NONE` for a software one. `h264_nvenc` answers `cuda`.
AVHWDeviceType encoderDeviceType(const AVCodec* codec);

/// Can this decoder use a device of `type`, and if so what pixel format do its
/// frames come out in? False leaves `*fmt` alone.
///
/// This is the check that turns "the card is there" into "the card can decode
/// *this*". A machine with two RTX 4090s still has no CUDA ProRes decoder, and
/// finding that out at the first frame of a render is finding it out too late.
bool decoderTakesDevice(const AVCodec* codec, AVHWDeviceType type, AVPixelFormat* fmt);

/// The type an `-hwaccel` name means, or `AV_HWDEVICE_TYPE_NONE`.
AVHWDeviceType hwTypeNamed(const std::string& name);

/// True when a pixel format is a handle to a picture on a device rather than
/// pixels in system memory — `AV_PIX_FMT_FLAG_HWACCEL`.
bool isHwPixelFormat(AVPixelFormat fmt);

} // namespace ffmpegbro
