// ffmpeg-bro — a GPL application built on the MIT bro engine.
//
// This is its own executable, not an app directory handed to bro.exe, and
// that is the whole design:
//
//   1. It links libav* directly, so decoding happens in-process and frames
//      reach the renderer without a subprocess or a pipe in between. That is
//      what "render what ffmpeg produces without re-encoding" actually asks
//      for.
//   2. Linking ffmpeg is what makes this binary GPL. bro stays MIT and
//      ffmpeg-free; libav* reaches the engine only through bro::video's
//      codec-agnostic interfaces, which exist for exactly this.
//
// One download, and <video src="anything.mkv"> works.

#include "engine/engine.h"
#include "engine/launcher.h"
#include "util/log.h"

#include "ffmpeg_backend.h"
#include "ffmpeg_bindings.h"

#include <cstdio>
#include <cstring>
#include <string>

namespace {

// Locate the UI directory: beside the executable in a packaged build, or up
// in the source tree when running straight out of build/Release.
bool locateUi(bro::engine::EngineConfig& config) {
    const std::string exe = bro::engine::executableDir();
    for (const char* rel : { "/ui", "/../../ui" }) {
        if (bro::engine::resolveLaunchTarget(exe + rel, config)) return true;
    }
    return false;
}

} // namespace

int main(int argc, char* argv[]) {
    if (argc >= 2 && (std::strcmp(argv[1], "--help") == 0 ||
                      std::strcmp(argv[1], "-h") == 0)) {
        std::fprintf(stderr,
            "ffmpeg-bro -- a comprehensive UI on ffmpeg\n"
            "\n"
            "Usage: ffmpeg-bro [media-file]\n");
        return 0;
    }

    // Before the Engine exists, so the first <video> in the first document
    // already finds it. bro's own WebM backend stays registered underneath.
    ffmpegbro::registerFfmpegBackend();

    bro::engine::EngineConfig config;
    config.title = "ffmpeg-bro";
    config.displayMode = bro::engine::DisplayMode::Windowed;
    config.settingsPath = bro::engine::executableDir() + "/.bro_settings.json";
    config.installHostBindings = ffmpegbro::installFfmpegBindings;

    if (!locateUi(config)) {
        LOG_ERROR("Cannot find the ffmpeg-bro UI next to %s",
                  bro::engine::executableDir().c_str());
        return 1;
    }
    bro::engine::publishLaunchEnv(config);

    // A media file named on the command line reaches the UI as
    // bro.ffmpeg.openOnStart: the engine's launch target is the UI, not the
    // media, so it can't arrive the usual way.
    if (argc >= 2) ffmpegbro::setInitialMedia(bro::engine::absolutePath(argv[1]));

    try {
        bro::engine::Engine engine(config);
        engine.run();
    } catch (const std::exception& e) {
        LOG_ERROR("Fatal: %s", e.what());
        return 1;
    }
    return 0;
}
