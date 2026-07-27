// Inputs that are assembled rather than opened.
//
// Three of ffmpeg's inputs are not a file: a numbered run of images, a single
// still held for a chosen length, and a list of files read end to end by the
// `concat` demuxer. Two things are being checked here and they are different
// kinds of thing —
//
//   - **that the scan groups files the way a person would.** This is the most
//     used path into the whole feature and the place a bad guess is most
//     annoying, so what is asserted is mostly what it *refuses*: a lone file
//     is not a sequence, a file beside a sequence is not part of it, and an
//     unpadded run whose numbers cross from one digit to two is one input and
//     not two;
//   - **that an input with no length of its own says so.** A still probes as
//     zero seconds, because it is zero seconds; with `-loop 1` it goes on
//     forever and `-t` is the only thing that can say how long it is. Nothing
//     here invents a duration, and the check that matters is that the number
//     the timeline would lay out comes from the input's own window.
//
// Then the output side, which is the same subject from the other end: a render
// into `out%04d.png` is a run of files rather than one, and the round trip —
// render a sequence, read it back as an input — is what says the two halves
// mean the same thing by a sequence.
//
// Usage: ffmpeg-bro-seqtest <fixture-directory>

#include "export_frame.h"
#include "export_source.h"
#include "ffmpeg_backend.h"
#include "ffmpeg_export.h"
#include "ffmpeg_input.h"
#include "ffmpeg_sequence.h"

#include "video/media_backend.h"
#include "video/media_source.h"

extern "C" {
#include <libavformat/avformat.h>
}

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

using namespace ffmpegbro;
namespace fs = std::filesystem;

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
    std::printf("  %s  %s\n", ok ? "PASS" : "FAIL", what.c_str());
    if (!ok) g_failures++;
}

void checkf(bool ok, const char* fmt, ...) {
    char buf[768];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    check(ok, buf);
}

bool endsWith(const std::string& s, const std::string& tail) {
    return s.size() >= tail.size() && s.compare(s.size() - tail.size(), tail.size(), tail) == 0;
}

const ImageSequence* sequenceEnding(const SequenceScan& scan, const std::string& tail) {
    for (const auto& s : scan.sequences)
        if (endsWith(s.pattern, tail)) return &s;
    return nullptr;
}

MediaInput of(const std::string& path) {
    MediaInput in;
    in.path = path;
    return in;
}

/// The mean absolute difference between two RGBA pictures, 0..255. The
/// fixtures are a bar crossing a gradient, so two different frames are nowhere
/// near zero and the same frame is exactly it.
double differ(const Rgba& a, const Rgba& b) {
    if (a.width != b.width || a.height != b.height || !a.width) return 255.0;
    double sum = 0;
    size_t n = 0;
    for (int y = 0; y < a.height; ++y) {
        const uint8_t* pa = a.data.data() + size_t(y) * a.stride;
        const uint8_t* pb = b.data.data() + size_t(y) * b.stride;
        for (int x = 0; x < a.width * 4; ++x) { sum += std::abs(int(pa[x]) - int(pb[x])); n++; }
    }
    return n ? sum / double(n) : 255.0;
}

Rgba copyOf(const Rgba* p) {
    Rgba out;
    if (!p) return out;
    out.resize(p->width, p->height);
    std::memcpy(out.data.data(), p->data.data(), p->data.size());
    return out;
}

ExportStatus render(const ExportSettings& s, const std::vector<ExportClip>& clips) {
    std::string err;
    if (!startExport(s, clips, &err)) {
        ExportStatus bad;
        bad.state = ExportStatus::State::Failed;
        bad.error = err;
        return bad;
    }
    waitForExport();
    return exportStatus();
}

} // namespace

int main(int argc, char* argv[]) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) {
        std::printf("usage: ffmpeg-bro-seqtest <fixture-directory>\n");
        return 2;
    }
    registerFfmpegBackend();

    const fs::path fixtures = argv[1];
    const fs::path framesDir = fixtures / "frames";
    const std::string still = (fixtures / "still.png").string();
    const std::string movie = (fixtures / "landscape.mp4").string();
    const fs::path outDir = "out";
    std::error_code ec;
    fs::create_directories(outDir, ec);

    std::printf("\nwhat a drop of files amounts to\n");
    {
        const SequenceScan scan = scanForSequences({framesDir.string()});
        checkf(scan.sequences.size() == 2, "a folder of two runs and a stray file is two "
               "sequences (%zu)", scan.sequences.size());

        const ImageSequence* shot = sequenceEnding(scan, "shot_%04d.png");
        check(shot != nullptr, "the padded run is written %04d, the width it is on disk");
        if (shot) {
            checkf(shot->digits == 4, "with four digits, not %d", shot->digits);
            checkf(shot->start == 1 && shot->end == 12 && shot->count == 12,
                   "and every one of its twelve frames, %lld..%lld (%d found)",
                   static_cast<long long>(shot->start), static_cast<long long>(shot->end),
                   shot->count);
            check(shot->missing == 0, "with no gap in it");
        }

        // The case the whole grouping rule turns on. Nothing is zero-padded,
        // so the width of the number carries no information and plate1 and
        // plate12 are the same run — grouped by width they would be two
        // inputs, which nobody could explain.
        const ImageSequence* plate = sequenceEnding(scan, "plate%d.png");
        check(plate != nullptr, "an unpadded run crossing from one digit to two is written %d");
        if (plate) {
            checkf(plate->digits == 0 && plate->count == 12,
                   "and is one sequence of twelve, not two (digits=%d count=%d)",
                   plate->digits, plate->count);
        }

        check(scan.singles.size() == 1 && endsWith(scan.singles[0], "logo.png"),
              "and the file beside them that is not part of either is left alone");
    }

    std::printf("\nwhat it refuses to guess\n");
    {
        const SequenceScan one = scanForSequences({(framesDir / "shot_0001.png").string()});
        check(one.sequences.empty() && one.singles.size() == 1,
              "one numbered file on its own is a still, not a sequence of one");

        const SequenceScan mixed = scanForSequences({still, framesDir.string()});
        check(mixed.sequences.size() == 2, "a still and a folder is the folder's runs");
        check(!mixed.singles.empty() && endsWith(mixed.singles[0], "still.png"),
              "with what was dropped first still first");

        const SequenceScan nothing = scanForSequences({movie});
        check(nothing.sequences.empty() && nothing.singles.size() == 1,
              "an mp4 has no image extension and takes no part in any of it");

        checkf(!imageExtensions().empty(),
               "the extensions are libavformat's own: %zu of them, %s…",
               imageExtensions().size(), imageExtensions().front().c_str());
        std::printf("  ....  this build %s do pattern_type=glob\n",
                    globPatternsSupported() ? "can" : "cannot");
    }

    std::printf("\na sequence, as an input\n");
    {
        const SequenceScan scan = scanForSequences({framesDir.string()});
        const ImageSequence* shot = sequenceEnding(scan, "shot_%04d.png");
        check(shot != nullptr, "the scan found something to open");
        if (shot) {
            // **The rate is an input option, not a property of the files.**
            // Twelve pictures are twelve pictures; how long each is on screen
            // is a decision, and the same twelve files are one second or two
            // depending only on what was decided.
            MediaInput at12 = of(shot->pattern);
            at12.format = "image2";
            at12.options.push_back({"framerate", "12"});
            const ProbeResult fast = probeMedia(at12);
            checkf(fast.ok && std::abs(fast.durationSec - 1.0) < 0.02,
                   "-framerate 12 makes twelve frames one second (%.3f) [%s]",
                   fast.durationSec, fast.error.c_str());

            MediaInput at6 = at12;
            at6.options[0].value = "6";
            const ProbeResult slow = probeMedia(at6);
            checkf(slow.ok && std::abs(slow.durationSec - 2.0) < 0.02,
                   "and -framerate 6 makes the same files two seconds (%.3f)", slow.durationSec);
            check(slow.streams.size() == 1 && slow.streams[0].width == 320 &&
                      slow.streams[0].height == 180,
                  "the pictures are the size they were written");

            // `-start_number` decides which file the run begins at, which is
            // why the scan reports where the numbers start: image2 looks for
            // the first five numbers from zero and gives up, so a run that
            // begins at 1000 is unopenable without it.
            MediaInput from5 = at12;
            from5.options.push_back({"start_number", "5"});
            const ProbeResult part = probeMedia(from5);
            checkf(part.ok && std::abs(part.durationSec - 8.0 / 12.0) < 0.02,
                   "-start_number 5 leaves eight of the twelve (%.3f s at 12 fps)",
                   part.durationSec);

            SourceVideo reader;
            std::string err;
            if (reader.open(at6, &err)) {
                const Rgba first = copyOf(reader.rgbaAt(0.05));
                const Rgba last = copyOf(reader.rgbaAt(1.9));
                checkf(differ(first, last) > 1.0,
                       "and a reader walks it: the bar has moved between the first frame and "
                       "the last (%.1f apart)", differ(first, last));
            } else {
                check(false, "a reader opens the sequence: " + err);
            }
        }
    }

    std::printf("\na still, which has no length of its own\n");
    {
        const ProbeResult bare = probeMedia(of(still));
        checkf(bare.ok && bare.durationSec == 0.0,
               "a single image probes as no time at all (%.3f), because that is what it is",
               bare.durationSec);

        MediaInput held = of(still);
        held.format = "image2";
        held.options.push_back({"loop", "1"});
        held.options.push_back({"framerate", "25"});
        held.duration = 3.0;
        check(inputIsEndless(held), "-loop 1 makes an input that never ends on its own");
        const ProbeResult chosen = probeMedia(held);
        checkf(chosen.ok && std::abs(chosen.durationSec - 3.0) < 0.001,
               "so -t is the whole of how long it is: %.3f s", chosen.durationSec);
        check(chosen.streams.size() == 1 && std::abs(chosen.streams[0].duration - 3.0) < 0.001,
              "and the video stream says the same, since that is where a clip's length "
              "comes from");

        SourceVideo reader;
        std::string err;
        if (reader.open(held, &err)) {
            check(reader.rgbaAt(0.1) != nullptr, "a reader has a picture at the start");
            check(reader.rgbaAt(2.9) != nullptr, "and one at two point nine seconds");
            check(reader.rgbaAt(3.5) == nullptr, "and none past the -t that ends it");
        } else {
            check(false, "a reader opens a held still: " + err);
        }

        // The same input without a `-t`. Nobody knows how long it is, and
        // saying zero is the only honest answer available — a number invented
        // here would be a clip laid out at a length nothing chose.
        MediaInput forever = held;
        forever.duration = 0.0;
        const ProbeResult open = probeMedia(forever);
        checkf(open.ok && open.durationSec == 0.0,
               "an endless input with no -t reports no duration rather than a guess (%.3f)",
               open.durationSec);
    }

    std::printf("\n-stream_loop\n");
    {
        MediaInput twice = of(movie);
        twice.streamLoop = 1;
        check(inputIsEndless(of(movie)) == false && inputIsEndless(twice),
              "-stream_loop makes an input endless and a plain path does not");

        SourceVideo plain, looped;
        std::string err;
        const bool both = plain.open(of(movie), &err) && looped.open(twice, &err);
        checkf(both, "two readers, one of them looping (%s)", both ? "ok" : err.c_str());
        if (both) {
            const Rgba at1 = copyOf(plain.rgbaAt(1.0));
            const Rgba last = copyOf(plain.rgbaAt(10.5));
            const Rgba past = copyOf(plain.rgbaAt(11.0));
            checkf(differ(last, past) < 1.0,
                   "past the end a plain reader holds its last picture (%.2f apart)",
                   differ(last, past));

            const Rgba again = copyOf(looped.rgbaAt(11.0));
            checkf(differ(at1, again) < 1.0,
                   "and the looping one is back at one second, eleven seconds in (%.2f apart)",
                   differ(at1, again));

            // Twice through and then the end, rather than forever: twenty-one
            // seconds is one second into a *third* pass, so a reader that had
            // ignored the count would be showing the same picture as at eleven.
            const Rgba after = copyOf(looped.rgbaAt(21.0));
            checkf(differ(at1, after) > 1.0,
                   "-stream_loop 1 is twice through and then the end, not forever (%.2f)",
                   differ(at1, after));
        }
    }

    std::printf("\nthe concat demuxer, which is not the concat filter\n");
    {
        const std::string list = (outDir / "seq-concat.txt").string();
        std::string err;
        // Absolute, because the concat demuxer resolves a relative entry
        // against the *list file's* directory and not against the process —
        // which is why the UI writes its lists out of paths it already holds
        // absolute and never out of what somebody typed.
        const std::string absMovie = fs::absolute(movie).string();
        const ProbeResult one = probeMedia(of(movie));
        check(writeConcatList(list, {{absMovie, one.durationSec}, {absMovie, one.durationSec}},
                              &err),
              "a list file is written: " + err);

        MediaInput joined = of(list);
        joined.format = "concat";
        // Absolute paths need it, and an option nothing consumed is an error
        // here as everywhere, so this is the demuxer's own and not decoration.
        joined.options.push_back({"safe", "0"});
        const ProbeResult r = probeMedia(joined);
        checkf(r.ok && r.durationSec > 19.0 && r.durationSec < 21.0,
               "and one file listed twice is one input of twice the length (%.2f s) [%s]",
               r.durationSec, r.error.c_str());

        // What the `duration` lines buy. Without them the demuxer opens the
        // first file at header time and finds out about the rest as it reaches
        // them, so the whole input reports nothing until something has read it
        // — and an input of no length lays out on a timeline as no clip.
        const std::string bare = (outDir / "seq-concat-bare.txt").string();
        writeConcatList(bare, {{absMovie, 0.0}, {absMovie, 0.0}}, &err);
        MediaInput unstated = joined;
        unstated.path = bare;
        const ProbeResult u = probeMedia(unstated);
        checkf(u.ok && u.durationSec == 0.0,
               "a list with no durations in it reports none at all (%.2f), which is why "
               "they are written", u.durationSec);
    }

    std::printf("\na sequence, written\n");
    {
        const std::string pattern = (outDir / "seq-out%04d.png").string();
        for (const auto& name : frameFilenames(pattern, 1, 12, nullptr))
            fs::remove(name, ec);

        ExportSettings s;
        s.path = pattern;
        s.format = "image2";
        s.width = 160;
        s.height = 90;
        s.fps = 5;
        s.startTime = 0;
        s.endTime = 1.2;
        s.videoCodec = "png";
        s.includeAudio = false;

        ExportClip clip;
        clip.path = movie;
        clip.start = 0;
        clip.length = 1.2;
        clip.x = 0; clip.y = 0; clip.w = 160; clip.h = 90;
        const ExportStatus st = render(s, {clip});
        checkf(st.state == ExportStatus::State::Done, "a render into image2 finishes (%s)",
               st.error.c_str());

        std::string err;
        const auto names = frameFilenames(pattern, 1, 6, &err);
        check(names.size() == 6, "and %04d names six files: " + err);
        int present = 0;
        for (const auto& n : names) if (fs::exists(n, ec)) present++;
        checkf(present == 6, "all six of which are on disk (%d)", present);
        check(!fs::exists(frameFilenames(pattern, 7, 1, nullptr)[0], ec),
              "and a seventh is not, because six frames is what was asked for");
        checkf(st.bytesWritten > 0,
               "the size reported is the run's and not a file called out%%04d.png (%lld bytes)",
               static_cast<long long>(st.bytesWritten));

        // The round trip. What the writer means by a sequence and what the
        // reader means by one have to be the same thing, or every one of these
        // features works on its own and none of them works together.
        MediaInput back = of(pattern);
        back.format = "image2";
        back.options.push_back({"framerate", "5"});
        const ProbeResult r = probeMedia(back);
        checkf(r.ok && std::abs(r.durationSec - 1.2) < 0.02,
               "and read back at the rate it was written it is the same 1.2 s (%.3f) [%s]",
               r.durationSec, r.error.c_str());

        SourceVideo reader;
        if (reader.open(back, &err)) {
            const Rgba* first = reader.rgbaAt(0.05);
            checkf(first && first->width == 160,
                   "and a reader gets the pictures back at the size they were written");
        } else {
            check(false, "a reader opens what was just written: " + err);
        }
    }

    std::printf("\none picture, which is the degenerate case\n");
    {
        const std::string one = (outDir / "seq-single.png").string();
        fs::remove(one, ec);
        check(!hasFramePattern(one), "a path with no %d in it is not a pattern");

        ExportSettings s;
        s.path = one;
        s.format = "image2";
        s.width = 160;
        s.height = 90;
        s.fps = 25;
        s.startTime = 2.0;
        s.endTime = 2.0 + 1.0 / 25.0;
        s.videoCodec = "png";
        s.includeAudio = false;
        // Without `-update 1` image2 says the name has no pattern in it and a
        // second frame would land on top of the first, which is the whole
        // reason a single-image output is a decision rather than a shorter
        // range.
        s.formatOptions.push_back({"update", "1"});

        ExportClip clip;
        clip.path = movie;
        clip.start = 0;
        clip.length = 4.0;
        clip.x = 0; clip.y = 0; clip.w = 160; clip.h = 90;
        const ExportStatus st = render(s, {clip});
        checkf(st.state == ExportStatus::State::Done, "one frame at the playhead writes (%s)",
               st.error.c_str());
        check(fs::exists(one, ec), "and there is a file, called what it was called");

        const ProbeResult r = probeMedia(of(one));
        checkf(r.ok && r.streams.size() == 1 && r.streams[0].width == 160,
               "which opens as one 160-wide picture [%s]", r.error.c_str());
    }

    std::printf("\n%s\n", g_failures ? "FAILED" : "all sequence checks passed");
    return g_failures ? 1 : 0;
}
