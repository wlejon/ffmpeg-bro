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
//   - **One soundtrack in which something happens.** Every other one here is a
//     continuous tone, which is what a mix check and a resampler check want and
//     is useless for a detector: in a tone nothing ever happens, so "found
//     nothing" and "was never called" are the same answer. `marks.m4a` carries
//     transients at 1, 3 and 5 seconds and a 1000 Hz tone from 6.0 to 7.5, over
//     a bed too quiet to be either — see `writeMarkable`.
//   - **The image fixtures are about the shape of a *drop*, not about the
//     picture.** A padded run, a file beside it that is not part of one, and
//     an unpadded run whose numbers cross from one digit to two — because what
//     the sequence scan has to get right is which files belong together, and
//     that is a property of the names rather than of the pixels. They are
//     written by the same `Writer` through the `image2` muxer, which makes
//     them the check that the picture side of it works at all.
//   - **Four of them are about a stream the others take for granted.**
//     `rotated.mp4` is stored sideways and carries a display matrix saying so,
//     which is the only thing that separates a portrait clip laid out upright
//     from one laid out on its side; `sound.m4a` has no video stream in it at
//     all, which is the mirror of `silent.mp4` and the only thing that
//     separates a clip from a clip with a picture in it; `telemetry.mp4` has a
//     `gpmd` data track, which is a stream that is neither picture, sound nor
//     cues, is carried by its fourcc alone, and carries **real GPMF** — a
//     payload whose `SCAL` divisors are the difference between 9.81 m/s² and
//     981; `picture-cues.mkv` has a `dvdsub`
//     track, whose cues are *pictures* of characters and therefore cannot be
//     converted, burned in or read for what they say. None can be faked with
//     content: a picture that happens to be tall is not a rotated one, a picture
//     that happens to be black is not an absent one, a track full of bytes is
//     not a track something can still identify or read, and a text track with an odd
//     payload is still a text track.
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

#include "gpmf_write.h"

#include "export_frame.h"
#include "export_writer.h"
#include "ffmpeg_export.h"

extern "C" {
#include <libavutil/display.h>
}

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
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
        if (!writer.writeVideo(canvas, {n}, &err)) {
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
bool writeSoundTrack(const std::filesystem::path& path, double seconds,
                     const char* what,
                     const std::function<float(int64_t, double)>& sampleAt) {
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
            const float v = sampleAt(at + i, t);
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
    std::printf("  %s  no video stream, %s %.1fs  %lld bytes\n",
                path.filename().string().c_str(), what, seconds,
                static_cast<long long>(writer.bytesSoFar()));
    return true;
}

/// The mirror above, as it was: one continuous tone and nothing else.
bool writeSoundOnly(const std::filesystem::path& path, double seconds, double toneHz) {
    char what[32];
    std::snprintf(what, sizeof(what), "%.0f Hz", toneHz);
    return writeSoundTrack(path, seconds, what, [toneHz](int64_t, double t) {
        return static_cast<float>(0.5 * std::sin(2.0 * kPi * toneHz * t));
    });
}

/// A soundtrack in which things **happen at particular seconds**.
///
/// Every other soundtrack here is a continuous tone, which is exactly right for
/// what those fixtures are about — a peak-RMS check, a resampler that went
/// wrong, a mix that has something in it — and is useless for the one question
/// this one exists for: does the acoustic sensor bus (`src/native/sound_marks.h`)
/// find a moment, and is the moment it finds *the* moment. In a continuous tone
/// nothing ever happens, so a detector that reported nothing and a detector that
/// was never called are the same result.
///
/// Four facts are built in, and none can be faked with content:
///
///   - **A quiet bed of stationary white noise, at about -60 dBFS.** Not digital
///     silence: an energy VAD measures a noise floor and gates against it, and a
///     floor of -120 dB makes every sound above it infinitely loud. -60 is also
///     below the VAD's own absolute floor (-55 dB), so the bed itself is never a
///     run of sound and the runs that *are* reported are the things put here on
///     purpose. Stationary is the load-bearing word — see the lambda.
///   - **Three transients, at 1, 3 and 5 seconds.** A 5 ms full-scale burst with
///     an exponential decay — broadband, so it is a step in the spectrum rather
///     than in one bin, which is what spectral flux measures. Spaced by two
///     seconds, which is forty times the detector's refractory period, so each
///     is unambiguously its own.
///   - **A tone at 1000 Hz from 6.0 to 7.5 s**, at -6 dBFS with 20 ms raised-
///     cosine edges. 1000 Hz sits well inside the tonality search range
///     (80..4000 Hz) and is a whole number of the analysis window, and the fades
///     are what stop the tone's own start being a transient so loud that the
///     run and the onset cannot be told apart. A detector that reports the run
///     but gets the frequency wrong is the failure this catches: 1000 is
///     nowhere near a harmonic or a subharmonic of anything else in the file.
///   - **Nothing between 7.5 s and the end.** Two seconds of bed, so that "the
///     last run ended" is a thing the file demonstrates rather than a thing the
///     end of the file forces.
bool writeMarkable(const std::filesystem::path& path) {
    const double clicks[] = { 1.0, 3.0, 5.0 };
    const double toneFrom = 6.0, toneTo = 7.5, toneHz = 1000.0, edge = 0.02;
    return writeSoundTrack(
        path, 9.5, "clicks at 1/3/5 s, 1000 Hz from 6.0 to 7.5 s",
        [&](int64_t i, double t) {
            // **Stationary** noise, not a quiet tone and not a modulated one.
            // The first bed tried here was a 137 Hz tone amplitude-modulated at
            // 3.1 Hz, and it made the fixture lie: PCEN divides each mel channel
            // by its own smoothed energy, so a bed that swells and fades is a
            // bed whose *normalised* spectrum moves, which is exactly what
            // spectral flux measures — eight onsets came out of the first
            // second of "silence", and the refractory period of the last of them
            // swallowed the real transient at 1.0 s. A test that then passed
            // would have been passing on a spurious mark. White noise at a
            // constant level has no flux once PCEN has settled.
            //
            // Keyed on the sample index rather than on `t` so the bytes are the
            // same however the writer blocks them, and by a hash rather than a
            // PRNG so no state crosses a block boundary. The constants are
            // xorshift's.
            uint64_t h = static_cast<uint64_t>(i) * 0x9E3779B97F4A7C15ull;
            h ^= h >> 29; h *= 0xBF58476D1CE4E5B9ull; h ^= h >> 32;
            double v = 0.001 * (double(int32_t(uint32_t(h))) / 2147483648.0);
            for (double c : clicks) {
                const double d = t - c;
                if (d >= 0.0 && d < 0.005)
                    v += 0.95 * std::exp(-d * 900.0) * std::sin(2.0 * kPi * 2500.0 * d);
            }
            if (t >= toneFrom && t < toneTo) {
                double a = 0.5;
                if (t - toneFrom < edge)
                    a *= 0.5 - 0.5 * std::cos(kPi * (t - toneFrom) / edge);
                if (toneTo - t < edge)
                    a *= 0.5 - 0.5 * std::cos(kPi * (toneTo - t) / edge);
                v += a * std::sin(2.0 * kPi * toneHz * t);
            }
            return static_cast<float>(v > 1.0 ? 1.0 : (v < -1.0 ? -1.0 : v));
        });
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

/// A clip with a **timed data track** beside its picture — an action camera's
/// telemetry, in the shape a real one has.
///
/// The fourth fixture that is about a stream the others take for granted, and
/// it cannot be faked either. A data stream is not a codec anything decodes: it
/// is packets whose meaning belongs to whatever reads them, identified by their
/// fourcc and nothing else. Every one of them — `gpmd`, `tmcd`, `mebx` — probes
/// as the same `bin_data`, so `gpmd` is written here deliberately: a copy that
/// drops the tag still produces a file with a data track in it, of the right
/// length, at the right times, that the reader it was carried for no longer
/// recognises. That is the failure worth having a fixture for, and the only
/// thing that catches it is a name.
///
/// **The payload is real GPMF**, and it has to be. It used to be a scrap of
/// text saying so, on the argument that a fixture imitating the real thing would
/// claim a capability that did not exist — and then the capability arrived
/// (data_gpmf.h), and a parser cannot be tested against a payload nothing wrote
/// in the format it parses. So this is a second fact this fixture exists for,
/// and one that cannot be faked either: **`SCAL` is a divisor**, and a value
/// reported without it is off by orders of magnitude while still looking
/// entirely plausible. `tests/gpmf_write.h` builds it, and builds it for the
/// parser test too, so the bytes here and the bytes that get damaged there are
/// the same bytes.
///
/// What stays true is the *shape*: a payload per second, on the video's clock,
/// in a stream the muxer numbers.
bool writeTelemetry(const std::filesystem::path& src, const std::filesystem::path& dst) {
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
        os->codecpar->codec_tag = 0;
        os->time_base = is->time_base;
        mapping[i] = os->index;
    }

    // The data track, last, so its index is not 0 or 1 — a copy that quietly
    // took "the first stream" would pass against a file where the interesting
    // one happened to be first.
    AVStream* data = avformat_new_stream(oc, nullptr);
    if (!data) {
        std::fprintf(stderr, "%s: cannot add the data stream\n", dst.string().c_str());
        avformat_close_input(&in);
        avformat_free_context(oc);
        return false;
    }
    data->codecpar->codec_type = AVMEDIA_TYPE_DATA;
    data->codecpar->codec_id = AV_CODEC_ID_BIN_DATA;
    data->codecpar->codec_tag = MKTAG('g', 'p', 'm', 'd');
    data->time_base = AVRational{1, 1000};

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

    // A sample per second for the length of the clip, interleaved with the
    // picture by the muxer. `av_interleaved_write_frame` needs them offered as
    // they come due, so they are pushed ahead of each video packet that has
    // passed the next whole second rather than all at the front.
    const double seconds = in->duration > 0 ? double(in->duration) / AV_TIME_BASE : 10.0;
    const int samples = std::max(1, static_cast<int>(seconds));
    int written = 0;
    auto pushData = [&](double upTo) {
        while (written < samples && double(written) <= upTo) {
            const gpmfw::Bytes payload = gpmfw::buildPayload(written);
            const int n = static_cast<int>(payload.size());
            AVPacket* dp = av_packet_alloc();
            av_new_packet(dp, n);
            std::memcpy(dp->data, payload.data(), payload.size());
            dp->stream_index = data->index;
            dp->pts = dp->dts = int64_t(written) * 1000;
            dp->duration = 1000;
            dp->flags |= AV_PKT_FLAG_KEY;
            dp->pos = -1;
            av_interleaved_write_frame(oc, dp);
            av_packet_free(&dp);
            ++written;
        }
    };

    AVPacket* pkt = av_packet_alloc();
    while (av_read_frame(in, pkt) >= 0) {
        const int to = mapping[pkt->stream_index];
        if (to >= 0) {
            const AVRational tb = in->streams[pkt->stream_index]->time_base;
            if (in->streams[pkt->stream_index]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO)
                pushData(double(pkt->pts) * tb.num / tb.den);
            av_packet_rescale_ts(pkt, tb, oc->streams[to]->time_base);
            pkt->stream_index = to;
            pkt->pos = -1;
            if (av_interleaved_write_frame(oc, pkt) < 0) break;
        }
        av_packet_unref(pkt);
    }
    pushData(double(samples));
    av_packet_free(&pkt);
    av_write_trailer(oc);
    const int64_t bytes = oc->pb ? avio_size(oc->pb) : 0;
    if (oc->pb) avio_closep(&oc->pb);
    avformat_close_input(&in);
    avformat_free_context(oc);

    std::printf("  %s  gpmd data track, %d GPMF payloads  %lld bytes\n",
                dst.filename().string().c_str(), written, static_cast<long long>(bytes));
    return true;
}

/// A clip whose cues are **pictures of characters** rather than characters.
///
/// The fifth fixture that is about a stream the others take for granted, and it
/// cannot be faked either: `cues.srt` and `cues.ass` are words, and every
/// question this application asks about a subtitle track forks on whether there
/// are words in it at all. A `dvdsub` track cannot become `subrip` (that is
/// optical character recognition), cannot be burned in (libavfilter's subtitles
/// filter is libass, and libass reads characters), and cannot be read for what
/// it says — and each of those has to be *refused by name*, which is a code path
/// nothing in the fixture set reaches. A text track with an unusual payload does
/// not reach it; only a track libavcodec reports without
/// `AV_CODEC_PROP_TEXT_SUB` does.
///
/// **Matroska, and beside a picture, both on purpose.** The container is the one
/// this build can hold `dvdsub` packets in, so the same file is what "carried
/// into a container that holds it" means. The video stream beside it is what
/// gives the cues a size: ffmpeg's own sub2video takes the canvas a bitmap cue
/// is painted onto from the largest video stream of the same input file when the
/// subtitle codec does not carry its own dimensions, and a subtitle-only file
/// would therefore be drawn at libavformat's 720×576 fallback rather than at
/// anything measurable.
///
/// The cues are at the same three moments `cues.srt` uses, so a render can be
/// checked against times that were written down before the file existed, and
/// each is a solid opaque box in the lower third — the only thing a check can
/// ask about a picture of text is that pixels changed where it was and did not
/// change where it was not.
bool writePictureCues(const std::filesystem::path& src, const std::filesystem::path& dst) {
    struct Moment { double start, end; };
    const Moment moments[] = {{1.0, 2.0}, {4.0, 5.5}, {7.0, 8.0}};

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

    // Everything that fails below has the same three things to give back, and
    // the function has eight ways out. One lambda rather than eight copies.
    AVCodecContext* enc = nullptr;
    const auto giveUp = [&](const char* what, int code) {
        std::fprintf(stderr, "%s: %s%s%s\n", dst.string().c_str(), what,
                     code < 0 ? " — " : "", code < 0 ? avErr(code).c_str() : "");
        if (enc) avcodec_free_context(&enc);
        avformat_close_input(&in);
        if (oc->pb) avio_closep(&oc->pb);
        avformat_free_context(oc);
        return false;
    };

    int width = 0, height = 0;
    std::vector<int> mapping(in->nb_streams, -1);
    for (unsigned i = 0; i < in->nb_streams; ++i) {
        AVStream* is = in->streams[i];
        AVStream* os = avformat_new_stream(oc, nullptr);
        if (!os || avcodec_parameters_copy(os->codecpar, is->codecpar) < 0)
            return giveUp("cannot copy a stream", 0);
        os->codecpar->codec_tag = 0;
        os->time_base = is->time_base;
        mapping[i] = os->index;
        if (is->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            width = is->codecpar->width;
            height = is->codecpar->height;
        }
    }
    if (width <= 0 || height <= 0) return giveUp("the source has no picture to size cues by", 0);

    // The encoder, asked for by name — `dvdsub` is what a bitmap subtitle
    // *encoder* is called in libavcodec, and a build without it should say so
    // here rather than write a file with a text track in it.
    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_DVD_SUBTITLE);
    if (!codec) return giveUp("this build has no dvdsub encoder", 0);
    enc = avcodec_alloc_context3(codec);
    if (!enc) return giveUp("out of memory", 0);
    // The size the cue coordinates are against. dvdsub writes it into its
    // extradata, which is how a decoder — and sub2video after it — knows how big
    // the canvas the rects sit on is.
    enc->width = width;
    enc->height = height;
    // Milliseconds, which is the clock a cue's display times are in and the one
    // the packets below are stamped on.
    enc->time_base = AVRational{1, 1000};
    if ((rc = avcodec_open2(enc, codec, nullptr)) < 0)
        return giveUp("cannot open the dvdsub encoder", rc);

    AVStream* subs = avformat_new_stream(oc, nullptr);
    if (!subs) return giveUp("cannot add the subtitle stream", 0);
    if ((rc = avcodec_parameters_from_context(subs->codecpar, enc)) < 0)
        return giveUp("cannot describe the subtitle stream", rc);
    subs->time_base = enc->time_base;

    if (!(oc->oformat->flags & AVFMT_NOFILE) &&
        (rc = avio_open(&oc->pb, dst.string().c_str(), AVIO_FLAG_WRITE)) < 0)
        return giveUp("cannot open it for writing", rc);
    if ((rc = avformat_write_header(oc, nullptr)) < 0)
        return giveUp("will not take a header", rc);

    // One rect per cue, in the lower third and the same box every time: what a
    // check can ask about a picture of text is that the picture changed where
    // the box is and not where it is not, and a box that moved would make the
    // second half of that unanswerable.
    const int boxW = std::max(2, (width / 2) & ~1);
    const int boxH = std::max(2, (height / 6) & ~1);
    const int boxX = ((width - boxW) / 2) & ~1;
    const int boxY = ((height - boxH - height / 12)) & ~1;

    // Four colours, which is what a DVD subtitle has: transparent, white, and
    // two more so the encoder's colour map is exercised rather than degenerate.
    // AVPALETTE entries are 0xAARRGGBB in the machine's own byte order.
    std::vector<uint32_t> palette(256, 0u);
    palette[0] = 0x00000000;   // transparent — everything outside the letters
    palette[1] = 0xFFFFFFFF;   // opaque white
    palette[2] = 0xFF000000;   // opaque black
    palette[3] = 0xFFFF3020;   // opaque red

    int written = 0;
    auto pushCue = [&](double upTo) {
        while (written < static_cast<int>(std::size(moments)) &&
               moments[written].start <= upTo) {
            const Moment& m = moments[written];
            std::vector<uint8_t> pixels(static_cast<size_t>(boxW) * boxH, 1);
            // A black frame two pixels in, so the bitmap is not one flat colour
            // and a palette that came through wrong is visible.
            for (int y = 0; y < boxH; ++y)
                for (int x = 0; x < boxW; ++x)
                    if (x < 2 || y < 2 || x >= boxW - 2 || y >= boxH - 2)
                        pixels[static_cast<size_t>(y) * boxW + x] = 2;

            AVSubtitleRect rect{};
            rect.type = SUBTITLE_BITMAP;
            rect.x = boxX;
            rect.y = boxY;
            rect.w = boxW;
            rect.h = boxH;
            rect.nb_colors = 4;
            rect.linesize[0] = boxW;
            rect.data[0] = pixels.data();
            rect.data[1] = reinterpret_cast<uint8_t*>(palette.data());
            AVSubtitleRect* rects[1] = {&rect};

            AVSubtitle sub{};
            sub.format = 0;                 // 0 is a bitmap; 1 would be text
            sub.num_rects = 1;
            sub.rects = rects;
            // **The timing is the cue's own, in milliseconds relative to the
            // packet.** `avcodec_encode_subtitle` refuses a non-zero
            // `start_display_time` outright, so the start is the packet's stamp
            // and the end is how long the picture stays up — which for dvdsub is
            // encoded into the payload as a stop-display command and is why such
            // a track's packets can carry no duration at all.
            sub.start_display_time = 0;
            sub.end_display_time =
                static_cast<uint32_t>(std::llround((m.end - m.start) * 1000.0));

            std::vector<uint8_t> payload(1 << 16);
            const int n = avcodec_encode_subtitle(enc, payload.data(),
                                                  static_cast<int>(payload.size()), &sub);
            if (n <= 0) {
                std::fprintf(stderr, "%s: cue %d would not encode\n",
                             dst.string().c_str(), written);
                ++written;
                continue;
            }
            AVPacket* sp = av_packet_alloc();
            av_new_packet(sp, n);
            std::memcpy(sp->data, payload.data(), static_cast<size_t>(n));
            sp->stream_index = subs->index;
            sp->pts = sp->dts = std::llround(m.start * 1000.0);
            sp->duration = std::llround((m.end - m.start) * 1000.0);
            sp->flags |= AV_PKT_FLAG_KEY;
            sp->pos = -1;
            av_interleaved_write_frame(oc, sp);
            av_packet_free(&sp);
            ++written;
        }
    };

    AVPacket* pkt = av_packet_alloc();
    while (av_read_frame(in, pkt) >= 0) {
        const int to = mapping[pkt->stream_index];
        if (to >= 0) {
            const AVRational tb = in->streams[pkt->stream_index]->time_base;
            // Offered as they come due, because `av_interleaved_write_frame`
            // buffers by timestamp and a cue handed over after the picture it
            // belongs beside has already gone out is a cue the muxer refuses.
            if (in->streams[pkt->stream_index]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO)
                pushCue(double(pkt->pts) * tb.num / tb.den);
            av_packet_rescale_ts(pkt, tb, oc->streams[to]->time_base);
            pkt->stream_index = to;
            pkt->pos = -1;
            if (av_interleaved_write_frame(oc, pkt) < 0) break;
        }
        av_packet_unref(pkt);
    }
    pushCue(1e9);
    av_packet_free(&pkt);
    av_write_trailer(oc);
    const int64_t bytes = oc->pb ? avio_size(oc->pb) : 0;
    if (oc->pb) avio_closep(&oc->pb);
    avcodec_free_context(&enc);
    avformat_close_input(&in);
    avformat_free_context(oc);

    std::printf("  %s  dvdsub track, %d picture cues %dx%d at (%d,%d)  %lld bytes\n",
                dst.filename().string().c_str(), written, boxW, boxH, boxX, boxY,
                static_cast<long long>(bytes));
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
        if (!writer.writeVideo(canvas, {n}, &err)) {
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
/// otherwise pass. And one cue of the three is *marked up*, for the reason
/// written beside it.
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
            // **One cue carries markup**, because a decoded cue does not arrive
            // as the words: every text decoder in libavcodec hands over an ASS
            // dialogue line, and `<i>` becomes `{\i1}…{\i0}` inside it. A reader
            // that printed the override codes instead of the words passes against
            // the two plain cues above and fails only against this one.
            "<i>third cue</i>",
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
    // The one soundtrack here in which anything ever *happens*. See
    // `writeMarkable` for what is in it and why each part of it cannot be
    // replaced by content.
    if (!writeMarkable(dir / "marks.m4a")) return 1;
    if (!writeRotated(dir / "landscape.mp4", dir / "rotated.mp4", 90)) return 1;
    if (!writeTelemetry(dir / "landscape.mp4", dir / "telemetry.mp4")) return 1;

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

    // And the one subtitle track that is not words: a `dvdsub` stream beside a
    // picture, which is the only fixture that reaches the three refusals a
    // bitmap track earns. See `writePictureCues`.
    if (!writePictureCues(dir / "landscape.mp4", dir / "picture-cues.mkv")) return 1;
    return 0;
}
