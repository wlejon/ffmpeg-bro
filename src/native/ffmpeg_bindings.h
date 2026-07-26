// bro.ffmpeg — the JS surface of the linked libav libraries.
#pragma once

#include <quickjs.h>

#include <string>

namespace ffmpegbro {

// A media file named on the command line. Surfaced as
// `bro.ffmpeg.openOnStart` — a binding rather than an environment variable so
// the UI needs nothing from the Node compatibility layer to find it.
void setInitialMedia(const std::string& path);

// Install `bro.ffmpeg` into a realm. Wired through
// EngineConfig::installHostBindings so every realm (reloads, iframes) gets it.
void installFfmpegBindings(JSContext* ctx);

} // namespace ffmpegbro
