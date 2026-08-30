// Bringing up one of this repository's applications.
//
// There are two, and they are two *executables* rather than two directories one
// launcher chooses between: `ffmpeg-bro` is the workbench over ffmpeg's whole
// model, and `supercut` is a single-purpose tool for cutting speech out of long
// recordings. A tool that opens on the job it does is worth more than a mode of
// a larger one, and a mode is what a `--app` flag would have made it — the same
// window title, the same icon on the taskbar, the same thing to explain. The
// second one is named `supercut` rather than `ffmpeg-bro-supercut` for the same
// reason: a name with the workbench's in it reads as a variant of it.
//
// What they share is everything below the UI: the same `ffmpeg-bro-core`, the
// same libav* registration, the same host bindings, the same engine. So the
// bring-up is one function taking the two things that actually differ — which
// directory holds the UI, and what the window is called — and the `main` on
// either side of it is a call.
//
// **Locating the UI is the part that must not be duplicated.** A packaged build
// puts the app under `app/` beside the executable and a build tree puts it two
// levels up (`build/Release/../../<app>`), and getting that wrong is an
// application that runs from one and not the other. It was written twice for
// about an hour and that is exactly what happened.
//
// **Why a package nests them under `app/` rather than putting them beside the
// binaries.** The second executable is called `supercut` and the directory
// holding its interface is called `supercut`, and on a case-sensitive
// filesystem those are the same name: a package with both at its root is a
// package that cannot be written on Linux or macOS. Nesting is the fix that
// costs nothing, because the build tree keeps working through the second probe
// below and a user still finds two binaries and nothing else at the top.

#pragma once

#include "engine/engine.h"
#include "engine/launcher.h"
#include "util/log.h"

#include "ffmpeg_backend.h"
#include "ffmpeg_bindings.h"
#include "ffmpeg_report.h"

#include <string>

namespace ffmpegbro {

/// Find `<dir>` under `app/` beside the executable, or up in the source tree.
///
/// The order is the order the two cases are distinguishable in: a package has
/// an `app/` and a build tree does not, so `app/` first can never shadow a
/// checkout. The bare `/` is kept behind both because a tree assembled by hand
/// (an executable dropped beside a `ui/`) is a reasonable thing to have and
/// used to be the packaged layout.
inline bool locateApp(const char* dir, bro::engine::EngineConfig& config) {
    const std::string exe = bro::engine::executableDir();
    for (const char* rel : { "/app/", "/../../", "/" }) {
        if (bro::engine::resolveLaunchTarget(exe + rel + dir, config)) return true;
    }
    return false;
}

/// Run the application whose UI is in `dir`, under the window title `title`,
/// remembering its window in `settingsFile` beside the executable.
///
/// **The settings file is named rather than derived from `dir`**, because the
/// two applications write beside the same executable directory and must not
/// overwrite each other's window — and because `ffmpeg-bro` already had one.
/// Deriving it would have quietly renamed that file and thrown away everybody's
/// window size to save one argument.
///
/// `argv[1]`, if there is one, is a media file, and it reaches the UI as
/// `bro.ffmpeg.openOnStart` rather than as the launch target: the engine is
/// being handed the application, so the file cannot arrive the usual way.
inline int runApp(const char* dir, const char* title, const char* settingsFile,
                  int argc, char* argv[]) {
    // First of all, because everything below this line logs: a build's
    // configuration, a demuxer that could not probe a file, an encoder that
    // clamped what it was given. Without the callback installed libav says all
    // of that to stderr and nowhere the application can reach, which is why a
    // render that came out wrong used to have nothing to look at.
    installLogCapture();

    // Before the Engine exists, so the first <video> in the first document
    // already finds it. bro's own WebM backend stays registered underneath.
    registerFfmpegBackend();

    bro::engine::EngineConfig config;
    config.title = title;
    config.displayMode = bro::engine::DisplayMode::Windowed;
    config.settingsPath = bro::engine::executableDir() + "/" + settingsFile;
    config.installHostBindings = installFfmpegBindings;

    if (!locateApp(dir, config)) {
        LOG_ERROR("Cannot find the %s UI next to %s", dir,
                  bro::engine::executableDir().c_str());
        return 1;
    }
    bro::engine::publishLaunchEnv(config);

    if (argc >= 2) setInitialMedia(bro::engine::absolutePath(argv[1]));

    try {
        bro::engine::Engine engine(config);
        engine.run();
    } catch (const std::exception& e) {
        LOG_ERROR("Fatal: %s", e.what());
        return 1;
    }
    return 0;
}

} // namespace ffmpegbro
