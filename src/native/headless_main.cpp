// ffmpeg-bro-headless — the same engine, the same libav backend, driven by a
// script instead of a window.
//
// This is how the UI gets tested: load index.html, drop a real file on it,
// step the clock, screenshot the viewer, assert on the DOM. It is also useful
// on its own — a scripted media tool with the whole of ffmpeg linked in and a
// full DOM to render reports into.

#include "engine/headless_driver.h"

#include "ffmpeg_backend.h"
#include "ffmpeg_bindings.h"

int main(int argc, char* argv[]) {
    bro::engine::HeadlessHooks hooks;
    hooks.programName = "ffmpeg-bro-headless";
    hooks.tagline = "scripted ffmpeg-bro: bro headless with libav linked in";
    hooks.beforeEngine = [] { ffmpegbro::registerFfmpegBackend(); };
    hooks.installHostBindings = ffmpegbro::installFfmpegBindings;
    return bro::engine::runHeadless(argc, argv, hooks);
}
