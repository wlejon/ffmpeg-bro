// Files that are one input. See ffmpeg_sequence.h.

#include "ffmpeg_sequence.h"

#include "ffmpeg_report.h"

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/avstring.h>
#include <libavutil/dict.h>
}

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>

namespace ffmpegbro {

namespace {

namespace fs = std::filesystem;

std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

/// The extension without its dot, lowercased. Empty when there is none.
std::string extOf(const fs::path& p) {
    std::string e = p.extension().string();
    if (!e.empty() && e[0] == '.') e.erase(0, 1);
    return lower(e);
}

/// `%` is the pattern's own character, so a name that contains one has to say
/// so or `image2` would read it as a specifier. `%%` is what its own filename
/// builder unescapes.
std::string escapePercent(const std::string& s) {
    std::string out;
    for (char c : s) {
        out += c;
        if (c == '%') out += '%';
    }
    return out;
}

/// A filename split at its last run of digits. False when there is no run.
struct Numbered {
    std::string prefix, suffix, digits;
    int64_t value = 0;
};

bool splitAtNumber(const std::string& name, Numbered* out) {
    size_t end = std::string::npos;
    for (size_t i = name.size(); i-- > 0;) {
        if (std::isdigit(static_cast<unsigned char>(name[i]))) { end = i + 1; break; }
    }
    if (end == std::string::npos) return false;
    size_t begin = end;
    while (begin > 0 && std::isdigit(static_cast<unsigned char>(name[begin - 1]))) begin--;
    out->prefix = name.substr(0, begin);
    out->digits = name.substr(begin, end - begin);
    out->suffix = name.substr(end);
    // A run long enough to overflow is not a frame number; it is a hash, and
    // treating it as one would produce a pattern nothing matches.
    if (out->digits.size() > 18) return false;
    out->value = std::stoll(out->digits);
    return true;
}

struct Member {
    int64_t value = 0;
    int width = 0;
    bool padded = false;
    std::string path;
};

ImageSequence buildSequence(const fs::path& dir, const std::string& prefix,
                            const std::string& suffix, int digits,
                            std::vector<Member> members) {
    std::sort(members.begin(), members.end(),
              [](const Member& a, const Member& b) { return a.value < b.value; });
    ImageSequence seq;
    seq.dir = dir.string();
    seq.prefix = prefix;
    seq.suffix = suffix;
    seq.digits = digits;
    seq.start = members.front().value;
    seq.end = members.back().value;
    seq.count = static_cast<int>(members.size());
    seq.first = members.front().path;
    const int64_t span = seq.end - seq.start + 1;
    seq.missing = static_cast<int>(std::max<int64_t>(0, span - seq.count));
    const std::string spec = digits > 0 ? "%0" + std::to_string(digits) + "d" : "%d";
    seq.pattern = (dir / (escapePercent(prefix) + spec + escapePercent(suffix))).string();
    return seq;
}

} // namespace

const std::vector<std::string>& imageExtensions() {
    static const std::vector<std::string> exts = [] {
        std::set<std::string> set;
        if (const AVOutputFormat* image2 = av_guess_format("image2", nullptr, nullptr)) {
            const char* e = image2->extensions;
            std::string one;
            for (const char* p = e ? e : ""; ; ++p) {
                if (*p == ',' || *p == 0) {
                    if (!one.empty()) set.insert(lower(one));
                    one.clear();
                    if (!*p) break;
                } else {
                    one += *p;
                }
            }
        }
        // Every still-image demuxer libavformat has, named after the thing it
        // reads: `webp_pipe`, `psd_pipe`, `svg_pipe`. The muxer's list above
        // is what libavformat *writes* and these are what it reads, and the
        // two are not the same set.
        void* it = nullptr;
        while (const AVInputFormat* f = av_demuxer_iterate(&it)) {
            const std::string name = f->name ? f->name : "";
            const std::string tail = "_pipe";
            if (name.size() > tail.size() &&
                name.compare(name.size() - tail.size(), tail.size(), tail) == 0)
                set.insert(lower(name.substr(0, name.size() - tail.size())));
        }
        return std::vector<std::string>(set.begin(), set.end());
    }();
    return exts;
}

SequenceScan scanForSequences(const std::vector<std::string>& paths) {
    SequenceScan out;
    const auto& exts = imageExtensions();
    const auto isImage = [&](const fs::path& p) {
        const std::string e = extOf(p);
        return !e.empty() && std::find(exts.begin(), exts.end(), e) != exts.end();
    };

    // Every candidate file, in the order it was given, plus everything one
    // level inside a folder that was given. A folder is *the* way somebody
    // hands over three hundred frames, and it is also the way somebody hands
    // over a folder with two sequences and a logo in it.
    std::vector<fs::path> files;
    std::vector<fs::path> nonImages;
    std::error_code ec;
    for (const auto& raw : paths) {
        const fs::path p(raw);
        if (fs::is_directory(p, ec)) {
            std::vector<fs::path> inside;
            for (fs::directory_iterator it(p, ec), last; !ec && it != last; it.increment(ec)) {
                if (it->is_regular_file(ec) && isImage(it->path())) inside.push_back(it->path());
            }
            std::sort(inside.begin(), inside.end());
            files.insert(files.end(), inside.begin(), inside.end());
        } else if (isImage(p)) {
            files.push_back(p);
        } else {
            nonImages.push_back(p);
        }
    }

    // Grouped by where they are and what surrounds the number. The extension
    // is part of the suffix, so a folder of PNGs beside the same frames as
    // JPEGs is two sequences and never one.
    struct Key {
        std::string dir, prefix, suffix;
        bool operator<(const Key& o) const {
            return std::tie(dir, prefix, suffix) < std::tie(o.dir, o.prefix, o.suffix);
        }
    };
    std::map<Key, std::vector<Member>> groups;
    std::vector<fs::path> unnumbered;
    for (const auto& f : files) {
        Numbered n;
        if (!splitAtNumber(f.filename().string(), &n)) { unnumbered.push_back(f); continue; }
        Member m;
        m.value = n.value;
        m.width = static_cast<int>(n.digits.size());
        m.padded = n.digits.size() > 1 && n.digits[0] == '0';
        m.path = f.string();
        groups[{f.parent_path().string(), n.prefix, n.suffix}].push_back(m);
    }

    std::vector<std::string> loose;
    for (auto& [key, members] : groups) {
        const bool padded = std::any_of(members.begin(), members.end(),
                                        [](const Member& m) { return m.padded; });
        if (!padded) {
            // Nothing is zero-padded, so the width carries no information and
            // `frame1` … `frame342` is one sequence written `%d`. Splitting it
            // by width is what would make three hundred files into three
            // inputs for no reason anybody could explain.
            if (members.size() >= 2)
                out.sequences.push_back(
                    buildSequence(key.dir, key.prefix, key.suffix, 0, members));
            else
                for (const auto& m : members) loose.push_back(m.path);
            continue;
        }
        // Something is padded, so the width is part of the name: `007` and
        // `0007` are two different runs and merging them would produce a
        // pattern that matches neither.
        std::map<int, std::vector<Member>> byWidth;
        for (const auto& m : members) byWidth[m.width].push_back(m);
        for (auto& [width, run] : byWidth) {
            if (run.size() >= 2)
                out.sequences.push_back(
                    buildSequence(key.dir, key.prefix, key.suffix, width, run));
            else
                for (const auto& m : run) loose.push_back(m.path);
        }
    }

    std::sort(out.sequences.begin(), out.sequences.end(),
              [](const ImageSequence& a, const ImageSequence& b) {
                  return a.pattern < b.pattern;
              });

    // Whatever did not join a run, back in the order it arrived: a file the
    // scan did not understand must not be lost, and it must not be reordered
    // either, because a drop of two clips is two clips in that order.
    std::set<std::string> claimed(loose.begin(), loose.end());
    for (const auto& p : unnumbered) claimed.insert(p.string());
    for (const auto& p : nonImages) claimed.insert(p.string());
    for (const auto& raw : paths) {
        const fs::path p(raw);
        if (fs::is_directory(p, ec)) continue;
        if (claimed.count(p.string())) out.singles.push_back(p.string());
    }
    // Loose files found *inside* a folder have no place in the drop order, so
    // they come after it.
    for (const auto& s : loose)
        if (std::find(out.singles.begin(), out.singles.end(), s) == out.singles.end())
            out.singles.push_back(s);
    for (const auto& p : unnumbered)
        if (std::find(out.singles.begin(), out.singles.end(), p.string()) == out.singles.end())
            out.singles.push_back(p.string());

    return out;
}

bool globPatternsSupported() {
    static const bool supported = [] {
        const AVInputFormat* image2 = av_find_input_format("image2");
        if (!image2) return false;
        LogQuiet quiet;
        AVFormatContext* ctx = nullptr;
        AVDictionary* opts = nullptr;
        av_dict_set(&opts, "pattern_type", "glob", 0);
        // A pattern with a character no filesystem allows in a name, so the
        // answer cannot depend on what happens to be on this disk. Without
        // glob the demuxer returns ENOSYS before looking at anything; with it,
        // the failure is that nothing matched, which is a different code.
        const int rc = avformat_open_input(&ctx, "\x01*ffmpeg-bro-glob-probe*", image2, &opts);
        av_dict_free(&opts);
        if (ctx) avformat_close_input(&ctx);
        return rc != AVERROR(ENOSYS);
    }();
    return supported;
}

bool hasFramePattern(const std::string& path) {
    return av_filename_number_test(path.c_str()) != 0;
}

std::vector<std::string> frameFilenames(const std::string& pattern, int64_t startNumber,
                                        int count, std::string* err) {
    std::vector<std::string> out;
    if (!hasFramePattern(pattern)) {
        if (err)
            *err = "'" + pattern + "' has no frame number in it — image2 needs something "
                   "like %04d, or -update 1 to write one file over and over";
        return out;
    }
    char buf[2048];
    for (int i = 0; i < count; ++i) {
        const int64_t n = startNumber + i;
        if (av_get_frame_filename2(buf, sizeof(buf), pattern.c_str(), static_cast<int>(n), 0) < 0) {
            if (err) *err = "'" + pattern + "' cannot be written for frame " + std::to_string(n);
            out.clear();
            return out;
        }
        out.emplace_back(buf);
    }
    return out;
}

bool writeConcatList(const std::string& path, const std::vector<ConcatEntry>& files,
                     std::string* err) {
    if (files.empty()) {
        if (err) *err = "a concat list with nothing in it is not an input";
        return false;
    }
    std::error_code ec;
    fs::create_directories(fs::path(path).parent_path(), ec);
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) {
        if (err) *err = "cannot write the concat list '" + path + "'";
        return false;
    }
    // The version line is what makes the file probe as a concat list, so it
    // opens without `-f concat` having to be forced — which matters because
    // the demuxer this input is opened with is a thing the Sources stage shows
    // and a thing somebody may have changed.
    f << "ffconcat version 1.0\n";
    for (const auto& one : files) {
        std::string quoted;
        for (char c : one.path) {
            // The concat parser's own escaping: a single quote ends the
            // quoted run, so it is closed, escaped and reopened.
            if (c == '\'') quoted += "'\\''";
            else if (c == '\\') quoted += "\\\\";
            else quoted += c;
        }
        f << "file '" << quoted << "'\n";
        // See the header: without this the whole input reports zero seconds
        // until something has read all of it.
        if (one.duration > 0.0) {
            char buf[64];
            std::snprintf(buf, sizeof(buf), "duration %.6f\n", one.duration);
            f << buf;
        }
    }
    f.flush();
    if (!f) {
        if (err) *err = "cannot write the concat list '" + path + "'";
        return false;
    }
    return true;
}

} // namespace ffmpegbro
