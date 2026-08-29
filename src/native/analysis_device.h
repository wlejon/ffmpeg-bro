// Which card an analysis runs on, asked once.
//
// Two models are loaded on this side now — Whisper in `transcribe.cpp` and
// Parakeet in `spoken_words.cpp` — and a third would make three copies of the
// same four lines. What they encode is not a preference of this application's:
// it is **bro's `stt` bindings' own precedence**, so that a model loaded here
// and one loaded through `bro.stt` land in the same place. Asking brotensor
// what is available rather than deciding is the "ask libav" convention one
// layer over.
//
// Header-only because it is one expression and because both callers already
// include brotensor to say what they want back.

#pragma once

#include <brotensor/runtime.h>
#include <brotensor/tensor.h>

#include <string>

namespace ffmpegbro {

/// `want` is 'cpu', 'cuda', 'metal', or empty for the best there is.
inline brotensor::Device analysisDeviceFor(const std::string& want) {
    if (want == "cpu") return brotensor::Device::CPU;
    if (want == "cuda") return brotensor::Device::CUDA;
    if (want == "metal") return brotensor::Device::Metal;
    if (brotensor::is_available(brotensor::Device::CUDA)) return brotensor::Device::CUDA;
    if (brotensor::is_available(brotensor::Device::Metal)) return brotensor::Device::Metal;
    return brotensor::Device::CPU;
}

} // namespace ffmpegbro
