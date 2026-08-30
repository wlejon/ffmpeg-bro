// supercut — one job, one window.
//
// The other executable is a workbench over the whole of ffmpeg's model, and its
// navigation *is* that model: Capture → Sources → Compose → Graph → Encode →
// Write. That is the right shape for the thing it is, and the wrong shape for
// this: cutting somebody's own words out of six-hour recordings is one task, and
// asking it of a pipeline builder means walking six stages to do a thing that
// has three controls in it.
//
// So this is a second application over the same engine rather than a seventh
// stage of the first. It shares everything below the interface — the same
// `ffmpeg-bro-core`, the same libav* registration, the same host bindings, the
// same `bro.ffmpeg` surface — and shares the *model* modules of the UI as well:
// the clips, the edit primitives, the render spec and the document format are
// all `ui/`'s, imported by `supercut/`. What it does not share is a single line
// of the interface. See the block at the top of `supercut/app.js`.
//
// A `.fbro` written here opens in `ffmpeg-bro`, because it is the same document
// by the same serialiser. That is the payoff of sharing the model: the simple
// tool is not a dead end, it is where an edit starts.

#include "app_main.h"

#include <cstdio>
#include <cstring>

int main(int argc, char* argv[]) {
    if (argc >= 2 && (std::strcmp(argv[1], "--help") == 0 ||
                      std::strcmp(argv[1], "-h") == 0)) {
        std::fprintf(stderr,
            "supercut -- find what was said, and cut it together\n"
            "\n"
            "Usage: supercut [document.fbro]\n"
            "\n"
            "Reads the corpus written by `tools/supercut.js index <channel>`\n"
            "at build/corpus/find.json, relative to the working directory.\n");
        return 0;
    }
    return ffmpegbro::runApp("supercut", "supercut", ".supercut_settings.json",
                             argc, argv);
}
