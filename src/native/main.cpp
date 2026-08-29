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
//
// The bring-up itself is `app_main.h`'s, shared with `ffmpeg-bro-supercut`.

#include "app_main.h"

#include <cstdio>
#include <cstring>

int main(int argc, char* argv[]) {
    if (argc >= 2 && (std::strcmp(argv[1], "--help") == 0 ||
                      std::strcmp(argv[1], "-h") == 0)) {
        std::fprintf(stderr,
            "ffmpeg-bro -- a comprehensive UI on ffmpeg\n"
            "\n"
            "Usage: ffmpeg-bro [media-file]\n");
        return 0;
    }
    return ffmpegbro::runApp("ui", "ffmpeg-bro", ".bro_settings.json", argc, argv);
}
