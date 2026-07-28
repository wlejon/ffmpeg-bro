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
//   - **Two of them are about a stream the others take for granted.**
//     `rotated.mp4` is stored sideways and carries a display matrix saying so,
//     which is the only thing that separates a portrait clip laid out upright
//     from one laid out on its side; `sound.m4a` has no video stream in it at
//     all, which is the mirror of `silent.mp4` and the only thing that
//     separates a clip from a clip with a picture in it. Neither can be faked
//     with content: a picture that happens to be tall is not a rotated one, and
//     a picture that happens to be black is not an absent one.
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

extern "C" {
#include <libavutil/display.h>
}

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
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
    // **A file with no audio stream at all**, which is a different fact from a
    // file whose audio is silent and is the one the UI kept getting wrong: a
    // stream list that offers "the mix, through aac" for a timeline with
    // nothing to mix prints `-map [a0]` against an `-i` that has no `[0:a]`,
    // and real ffmpeg answers "Stream specifier ':a' matches no streams".
    // Only a fixture with the stream genuinely absent separates the two.
    bool sound;
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
    s.includeAudio = r.sound;
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

        if (!r.sound) continue;
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
    const std::string tone = r.sound ? std::to_string(int(r.toneHz)) + " Hz"
                                     : std::string("no audio stream");
    std::printf("  %s  %dx%d %.0f fps %.1fs %s  %lld bytes\n", r.name, r.width, r.height,
                r.fps, r.seconds, tone.c_str(),
                static_cast<long long>(writer.bytesSoFar()));
    return true;
}

/// A file with sound in it and **no video stream at all** — the mirror of
/// `silent.mp4` one stream kind over.
///
/// It earns its keep the same way that one does. Half of this application's
/// model of an edit is "a picture at t", and every part of it that assumed a
/// clip has one passed against the three files above: the viewer laid a clip
/// with no pictures out as a black rectangle over whatever was beneath it, the
/// timeline drew it as a clip whose thumbnails had not arrived yet, the
/// derivation refused the whole edit with "a clip has no rectangle to be drawn
/// in", and the Write stage offered a composite for a timeline that has nothing
/// to compose. A file whose picture is merely black does not separate any of
/// those from working; only one with the stream genuinely absent does.
///
/// Written through the same `Writer` as everything else, with a stream list of
/// exactly one audio stream — which is the whole of how you say "no picture" to
/// it, since an empty list is the renderer's sentinel for the usual two.
bool writeSoundOnly(const std::filesystem::path& path, double seconds, double toneHz) {
    ExportSettings s;
    s.path = path.string();
    s.format = "mp4";
    // Unused by an audio stream, and set anyway: a size of zero anywhere in a
    // spec is the sort of thing a later reader treats as a question.
    s.width = 640;
    s.height = 360;
    s.fps = 25.0;
    s.startTime = 0;
    s.endTime = seconds;
    s.audioCodec = "aac";
    s.includeAudio = true;
    s.audioSampleRate = 48000;
    s.audioChannels = 2;
    ExportStream a;
    a.kind = "audio";
    a.source = "mix";
    a.codec = "aac";
    s.streams.push_back(a);

    Writer writer;
    std::string err;
    if (!writer.open(s, true, &err)) {
        std::fprintf(stderr, "%s: %s\n", path.string().c_str(), err.c_str());
        return false;
    }

    const int block = 1024;
    const int64_t total = static_cast<int64_t>(std::llround(seconds * s.audioSampleRate));
    std::vector<float> samples;
    for (int64_t at = 0; at < total; at += block) {
        const int count = static_cast<int>(std::min<int64_t>(block, total - at));
        samples.assign(static_cast<size_t>(count) * s.audioChannels, 0.0f);
        for (int i = 0; i < count; ++i) {
            const double t = double(at + i) / s.audioSampleRate;
            const float v = static_cast<float>(0.5 * std::sin(2.0 * kPi * toneHz * t));
            for (int c = 0; c < s.audioChannels; ++c)
                samples[static_cast<size_t>(i) * s.audioChannels + c] = v;
        }
        if (!writer.writeAudio(samples.data(), count, &err)) {
            std::fprintf(stderr, "%s: %s\n", path.string().c_str(), err.c_str());
            return false;
        }
    }
    if (!writer.finish(&err)) {
        std::fprintf(stderr, "%s: %s\n", path.string().c_str(), err.c_str());
        return false;
    }
    std::printf("  %s  no video stream, %.0f Hz %.1fs  %lld bytes\n",
                path.filename().string().c_str(), toneHz, seconds,
                static_cast<long long>(writer.bytesSoFar()));
    return true;
}

/// A file whose pictures are stored one way up and meant to be seen another —
/// which is what every phone in the world writes.
///
/// **A display matrix is a fact about a container, not about a picture**, so
/// this is a stream copy of a fixture that already exists with the side datum
/// added to the output stream. Going through the `Writer` instead would mean
/// giving `ExportStream` a rotation field, which would be a knob on the render
/// for the benefit of a test: nothing in this application writes a rotated file
/// on purpose, and everything in it has to *read* one correctly. The remux is
/// the honest shape and it is thirty lines.
///
/// **`av_display_rotation_set` and `av_display_rotation_get` are not inverses**,
/// and the sign is worth writing down because getting it wrong writes a fixture
/// that is rotated the other way and passes every check that does not name a
/// number. `set(θ)` builds its matrix from `-θ` radians and `get` returns
/// `-atan2(m[1], m[0])`, so `get(set(θ)) == -θ`; `rotationOf` then negates once
/// more to turn libav's anticlockwise convention into the clockwise one bro
/// wants. The two negations cancel, so `set(90)` is what a fixture that has to
/// be turned a quarter turn *clockwise* to be upright is written with.
bool writeRotated(const std::filesystem::path& src, const std::filesystem::path& dst,
                  int degrees) {
    AVFormatContext* in = nullptr;
    int rc = avformat_open_input(&in, src.string().c_str(), nullptr, nullptr);
    if (rc < 0 || avformat_find_stream_info(in, nullptr) < 0) {
        std::fprintf(stderr, "%s: cannot reopen (%s)\n", src.string().c_str(),
                     avErr(rc).c_str());
        if (in) avformat_close_input(&in);
        return false;
    }

    AVFormatContext* oc = nullptr;
    if (avformat_alloc_output_context2(&oc, nullptr, nullptr, dst.string().c_str()) < 0 || !oc) {
        std::fprintf(stderr, "%s: no muxer\n", dst.string().c_str());
        avformat_close_input(&in);
        return false;
    }

    std::vector<int> mapping(in->nb_streams, -1);
    for (unsigned i = 0; i < in->nb_streams; ++i) {
        AVStream* is = in->streams[i];
        AVStream* os = avformat_new_stream(oc, nullptr);
        if (!os || avcodec_parameters_copy(os->codecpar, is->codecpar) < 0) {
            std::fprintf(stderr, "%s: cannot copy stream %u\n", dst.string().c_str(), i);
            avformat_close_input(&in);
            avformat_free_context(oc);
            return false;
        }
        // The muxer picks its own tag; the input's belongs to the input's
        // container even when it is the same one.
        os->codecpar->codec_tag = 0;
        os->time_base = is->time_base;
        mapping[i] = os->index;

        if (is->codecpar->codec_type != AVMEDIA_TYPE_VIDEO) continue;
        AVPacketSideData* sd = av_packet_side_data_new(
            &os->codecpar->coded_side_data, &os->codecpar->nb_coded_side_data,
            AV_PKT_DATA_DISPLAYMATRIX, sizeof(int32_t) * 9, 0);
        if (!sd) {
            std::fprintf(stderr, "%s: no room for a display matrix\n", dst.string().c_str());
            avformat_close_input(&in);
            avformat_free_context(oc);
            return false;
        }
        av_display_rotation_set(reinterpret_cast<int32_t*>(sd->data), double(degrees));
    }

    if (!(oc->oformat->flags & AVFMT_NOFILE) &&
        (rc = avio_open(&oc->pb, dst.string().c_str(), AVIO_FLAG_WRITE)) < 0) {
        std::fprintf(stderr, "%s: %s\n", dst.string().c_str(), avErr(rc).c_str());
        avformat_close_input(&in);
        avformat_free_context(oc);
        return false;
    }
    if ((rc = avformat_write_header(oc, nullptr)) < 0) {
        std::fprintf(stderr, "%s: %s\n", dst.string().c_str(), avErr(rc).c_str());
        avformat_close_input(&in);
        if (oc->pb) avio_closep(&oc->pb);
        avformat_free_context(oc);
        return false;
    }

    AVPacket* pkt = av_packet_alloc();
    while (av_read_frame(in, pkt) >= 0) {
        const int to = mapping[pkt->stream_index];
        if (to >= 0) {
            av_packet_rescale_ts(pkt, in->streams[pkt->stream_index]->time_base,
                                 oc->streams[to]->time_base);
            pkt->stream_index = to;
            pkt->pos = -1;
            if (av_interleaved_write_frame(oc, pkt) < 0) break;
        }
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    av_write_trailer(oc);
    const int64_t bytes = oc->pb ? avio_size(oc->pb) : 0;
    if (oc->pb) avio_closep(&oc->pb);
    avformat_close_input(&in);
    avformat_free_context(oc);

    std::printf("  %s  %d° display matrix  %lld bytes\n", dst.filename().string().c_str(),
                degrees, static_cast<long long>(bytes));
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

/// Subtitles, as the two text formats everything else converts between.
///
/// Written as bytes rather than through a `Writer`, because that is what a
/// subtitle file is: a few lines of text somebody typed, and the whole point of
/// a fixture is that a render can be checked against times and words that were
/// known before the file existed.
///
/// **The cues are placed so that a burn-in is measurable.** A second of picture
/// with nothing over it, a second with a line over it, a second with nothing
/// again — so a render through `subtitles=` and a render without it are
/// provably identical outside the cue and provably different inside it. That
/// pair of measurements is the only check that says a subtitle was actually
/// drawn; "the render succeeded" says nothing at all.
///
/// The words differ between the two files on purpose. A conversion that wrote
/// its input straight back out, or that read the wrong one of the two, would
/// otherwise pass.
bool writeSubtitles(const std::filesystem::path& dir) {
    struct Sidecar { const char* name; std::vector<std::string> lines; };
    const Sidecar files[] = {
        {"cues.srt", {
            "1",
            "00:00:01,000 --> 00:00:02,000",
            "first cue",
            "",
            "2",
            "00:00:04,000 --> 00:00:05,500",
            "second cue",
            "and its second line",
            "",
            "3",
            "00:00:07,000 --> 00:00:08,000",
            "third cue",
            "",
        }},
        // The same three moments in the format that carries styling, so a
        // render asked for `ass` can be checked against something other than a
        // conversion of the file above.
        {"cues.ass", {
            "[Script Info]",
            "ScriptType: v4.00+",
            "PlayResX: 640",
            "PlayResY: 360",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
            "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
            "MarginR, MarginV, Encoding",
            "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,"
            "0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
            "Effect, Text",
            "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,styled one",
            "Dialogue: 0,0:00:04.00,0:00:05.50,Default,,0,0,0,,styled two",
            "Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,styled three",
            "",
        }},
    };
    for (const auto& f : files) {
        const std::filesystem::path path = dir / f.name;
        // Binary, so the line endings are the ones written here on every
        // platform: a subtitle parser counts blank lines, and a text-mode
        // write on Windows turns each of them into two bytes.
        std::ofstream out(path, std::ios::binary);
        if (!out) {
            std::fprintf(stderr, "%s: cannot write\n", path.string().c_str());
            return false;
        }
        size_t bytes = 0;
        for (const auto& line : f.lines) {
            out << line << "\n";
            bytes += line.size() + 1;
        }
        std::printf("  %s  %zu lines  %zu bytes\n", f.name, f.lines.size(), bytes);
    }
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
    // The third has **no audio stream in it at all**, which is not the same
    // file as one whose soundtrack is quiet. Half of this application's model
    // of a render is "the mix", and every part of it that assumed a clip has a
    // soundtrack to contribute passed against the two above — the Write stage
    // offered a stream nothing feeds and the command bar printed `-map [a0]`
    // for a pad no `-i` produces. Short, because nothing measures it.
    const Recipe recipes[] = {
        {"landscape.mp4", 640, 360, 25.0, 10.0, 440.0, 1, true},
        {"portrait.mp4",  360, 640, 30.0,  8.0, 660.0, 2, true},
        {"silent.mp4",    480, 270, 25.0,  4.0,   0.0, 0, false},
    };

    std::printf("writing fixtures into %s\n", dir.string().c_str());
    for (const auto& r : recipes)
        if (!write(r, dir / r.name)) return 1;

    // The two files that are each about a stream the others take for granted:
    // one that is stored sideways, and one with no picture in it at all. See
    // the functions themselves for why neither can be faked with content.
    if (!writeSoundOnly(dir / "sound.m4a", 6.0, 330.0)) return 1;
    if (!writeRotated(dir / "landscape.mp4", dir / "rotated.mp4", 90)) return 1;

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

    // Subtitles, whose three cues fall inside the landscape fixture's ten
    // seconds — so the same file can be burned into it, muxed beside it and
    // converted, all against times that are written down above.
    if (!writeSubtitles(dir)) return 1;
    return 0;
}
