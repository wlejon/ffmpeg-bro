// Media to test against, generated rather than checked in.
//
// Every test in this repo used to take a real file as an argument, which meant
// none of them could be run by `ctest` and all of them depended on what the
// file happened to contain. That is not a theoretical problem: a source whose
// audio track is digitally silent turns the export test's mixer check into a
// failure that reads as a broken mixer, and a source that is mostly black
// makes a picture check pass for the wrong reason.
//
// So the fixtures are made here, deterministically, with known content:
//
//   - **The picture is never black and never uniform.** A moving bar over a
//     gradient, so "did a clip land in this rectangle" and "is this half of the
//     canvas still black" are both answerable, and so a frame from one moment
//     is distinguishable from a frame at another.
//   - **The sound is audible and is a known tone.** -6 dBFS at a frequency
//     that divides the sample rate evenly, so a peak-RMS check means what it
//     says and a resampler that went wrong is audible in the result.
//   - **The image fixtures are about the shape of a *drop*, not about the
//     picture.** A padded run, a file beside it that is not part of one, and
//     an unpadded run whose numbers cross from one digit to two — because what
//     the sequence scan has to get right is which files belong together, and
//     that is a property of the names rather than of the pixels. They are
//     written by the same `Writer` through the `image2` muxer, which makes
//     them the check that the picture side of it works at all.
//   - **The two files differ in every way a render cares about**: size, aspect,
//     frame rate and duration. A test that passes only because both inputs are
//     1080p25 is a test that has not been run. This one is not decoration: the
//     portrait file is 360 wide, which is not a whole number of libswscale's
//     output blocks, and that is what caught buffers sized to exactly
//     width*height writing past their end. The 640-wide file passed the same
//     code every time. Keep a fixture whose width is not a multiple of sixteen.
//
// It writes through the same Writer the renderer uses, which is worth noting:
// the fixture generator is thirty lines of "make a canvas, hand it over"
// because everything past that seam is already a component.
//
// Usage: ffmpeg-bro-mkfixture <directory>

#include "export_frame.h"
#include "export_writer.h"
#include "ffmpeg_export.h"

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

using namespace ffmpegbro;

namespace {

constexpr double kPi = 3.14159265358979323846;

struct Recipe {
    const char* name;
    int width, height;
    double fps;
    double seconds;
    double toneHz;
    uint8_t tint;          // which channel the gradient leans on
};

/// A frame that is different from every other frame: a vertical gradient, a
/// horizontal one, and a bar that crosses the picture over the clip's length.
void paint(Rgba& canvas, double phase, uint8_t tint) {
    const int w = canvas.width, h = canvas.height;
    const int barX = static_cast<int>(phase * (w - 1));
    for (int y = 0; y < h; ++y) {
        uint8_t* row = canvas.data.data() + static_cast<size_t>(y) * canvas.stride;
        const int vertical = (y * 200) / (h > 1 ? h - 1 : 1);
        for (int x = 0; x < w; ++x) {
            const int horizontal = (x * 200) / (w > 1 ? w - 1 : 1);
            const bool onBar = std::abs(x - barX) < std::max(2, w / 32);
            uint8_t* px = row + static_cast<size_t>(x) * 4;
            px[0] = static_cast<uint8_t>(onBar ? 255 : (tint == 0 ? 55 + horizontal : 30));
            px[1] = static_cast<uint8_t>(onBar ? 255 : (tint == 1 ? 55 + vertical : 40 + vertical / 4));
            px[2] = static_cast<uint8_t>(onBar ? 255 : (tint == 2 ? 55 + horizontal : 30 + horizontal / 4));
            px[3] = 255;
        }
    }
}

bool write(const Recipe& r, const std::filesystem::path& path) {
    ExportSettings s;
    s.path = path.string();
    s.width = r.width;
    s.height = r.height;
    s.fps = r.fps;
    s.startTime = 0;
    s.endTime = r.seconds;
    s.videoCodec = "libx264";
    s.audioCodec = "aac";
    s.crf = 20;
    s.preset = "veryfast";
    s.includeAudio = true;
    s.audioSampleRate = 48000;
    s.audioChannels = 2;

    Writer writer;
    std::string err;
    if (!writer.open(s, true, &err)) {
        std::fprintf(stderr, "%s: %s\n", r.name, err.c_str());
        return false;
    }

    Rgba canvas;
    canvas.resize(r.width, r.height);
    const int64_t frames = static_cast<int64_t>(std::llround(r.seconds * r.fps));
    std::vector<float> samples;
    int64_t samplesWritten = 0;

    for (int64_t n = 0; n < frames; ++n) {
        paint(canvas, double(n) / double(frames > 1 ? frames - 1 : 1), r.tint);
        if (!writer.writeVideo(canvas, n, &err)) {
            std::fprintf(stderr, "%s: %s\n", r.name, err.c_str());
            return false;
        }

        const int64_t upTo = std::llround((double(n + 1) / r.fps) * s.audioSampleRate);
        const int count = static_cast<int>(upTo - samplesWritten);
        if (count > 0) {
            samples.assign(static_cast<size_t>(count) * s.audioChannels, 0.0f);
            for (int i = 0; i < count; ++i) {
                const double t = double(samplesWritten + i) / s.audioSampleRate;
                // -6 dBFS: loud enough that a peak check is unambiguous, quiet
                // enough that summing two of them does not sit on the clamp.
                const float v = static_cast<float>(0.5 * std::sin(2.0 * kPi * r.toneHz * t));
                for (int c = 0; c < s.audioChannels; ++c)
                    samples[static_cast<size_t>(i) * s.audioChannels + c] = v;
            }
            if (!writer.writeAudio(samples.data(), count, &err)) {
                std::fprintf(stderr, "%s: %s\n", r.name, err.c_str());
                return false;
            }
            samplesWritten = upTo;
        }
    }

    if (!writer.finish(&err)) {
        std::fprintf(stderr, "%s: %s\n", r.name, err.c_str());
        return false;
    }
    std::printf("  %s  %dx%d %.0f fps %.1fs %.0f Hz  %lld bytes\n", r.name, r.width, r.height,
                r.fps, r.seconds, r.toneHz, static_cast<long long>(writer.bytesSoFar()));
    return true;
}

/// A run of stills, written the way this application writes one: the `image2`
/// muxer, a frame-number pattern for a path, and `-start_number` said out loud
/// rather than left to a default nobody can see.
///
/// `count == 1` writes exactly one file, which needs `-update 1`: without it
/// image2 says the name has no pattern in it and the *next* frame would land
/// on top of the first. A still is the degenerate sequence, and the muxer
/// treats it as one.
bool writeStills(const std::filesystem::path& pattern, int count, int width, int height,
                 int startNumber, uint8_t tint) {
    ExportSettings s;
    s.path = pattern.string();
    s.format = "image2";
    s.width = width;
    s.height = height;
    s.fps = 25.0;
    s.startTime = 0;
    s.endTime = count / 25.0;
    s.videoCodec = "png";
    s.includeAudio = false;
    if (count == 1) s.formatOptions.push_back({"update", "1"});
    else s.formatOptions.push_back({"start_number", std::to_string(startNumber)});

    Writer writer;
    std::string err;
    if (!writer.open(s, false, &err)) {
        std::fprintf(stderr, "%s: %s\n", pattern.string().c_str(), err.c_str());
        return false;
    }
    Rgba canvas;
    canvas.resize(width, height);
    for (int n = 0; n < count; ++n) {
        paint(canvas, double(n) / double(count > 1 ? count - 1 : 1), tint);
        if (!writer.writeVideo(canvas, n, &err)) {
            std::fprintf(stderr, "%s: %s\n", pattern.string().c_str(), err.c_str());
            return false;
        }
    }
    if (!writer.finish(&err)) {
        std::fprintf(stderr, "%s: %s\n", pattern.string().c_str(), err.c_str());
        return false;
    }
    std::printf("  %s  %d file%s %dx%d  %lld bytes\n", pattern.filename().string().c_str(),
                count, count == 1 ? "" : "s", width, height,
                static_cast<long long>(writer.bytesSoFar()));
    return true;
}

}  // namespace

int main(int argc, char* argv[]) {
    const std::filesystem::path dir = argc >= 2 ? argv[1] : "out/fixtures";
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);

    // Landscape and portrait, two frame rates, two lengths, two tones.
    //
    // The lengths are not arbitrary: decode_test.cpp walks sixty frames forward
    // and sixty back and asserts every step moved, so a fixture has to be
    // comfortably longer than that at its own rate — sixty frames is 2.4 s at
    // 25 fps and 2 s at 30. Ten and eight seconds leave room for that, for the
    // export test's range, and for the player test to play through.
    const Recipe recipes[] = {
        {"landscape.mp4", 640, 360, 25.0, 10.0, 440.0, 1},
        {"portrait.mp4",  360, 640, 30.0,  8.0, 660.0, 2},
    };

    std::printf("writing fixtures into %s\n", dir.string().c_str());
    for (const auto& r : recipes)
        if (!write(r, dir / r.name)) return 1;

    // Stills, in the arrangement a sequence scan has to make sense of: a
    // padded run, a file beside it that is not part of one, and an unpadded
    // run whose numbers cross from one digit to two. The third is the case
    // that decides whether the scan is any good — grouped by digit width it
    // comes out as two inputs, and nobody would be able to say why.
    const std::filesystem::path frames = dir / "frames";
    std::filesystem::create_directories(frames, ec);
    if (!writeStills(frames / "shot_%04d.png", 12, 320, 180, 1, 1)) return 1;
    if (!writeStills(frames / "plate%d.png", 12, 160, 90, 1, 2)) return 1;
    if (!writeStills(frames / "logo.png", 1, 64, 64, 1, 0)) return 1;
    if (!writeStills(dir / "still.png", 1, 320, 180, 1, 2)) return 1;
    return 0;
}
