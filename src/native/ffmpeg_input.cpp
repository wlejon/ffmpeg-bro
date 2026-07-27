// An input is an `-i`. See ffmpeg_input.h.

#include "ffmpeg_input.h"

#include "export_frame.h"       // avErr

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/dict.h>
}

#include <map>
#include <mutex>

namespace ffmpegbro {

namespace {

/// The prefix a registered input's token carries.
///
/// It starts with `/` on purpose, and that is the whole reason this is a token
/// rather than the path itself. bro resolves a `<video src>` against the
/// document unless it looks absolute, and "looks absolute" is `x:` or a leading
/// slash — so `https://example.com/a.mp4` would be resolved to
/// `…/ui/https://example.com/a.mp4` and quietly fail, while `/@input/7` is left
/// exactly as written. One prefix therefore buys two things: an input's options
/// reach playback, and a URL can be played at all.
const char* kPrefix = "/@input/";

std::mutex& lock() {
    static std::mutex m;
    return m;
}

std::map<std::string, MediaInput>& table() {
    static std::map<std::string, MediaInput> t;
    return t;
}

} // namespace

bool openInput(AVFormatContext** out, const MediaInput& in, std::string* err) {
    if (!out) return false;
    *out = nullptr;
    if (in.path.empty()) {
        if (err) *err = "this input has no path or URL to open";
        return false;
    }

    const AVInputFormat* forced = nullptr;
    if (!in.format.empty()) {
        forced = av_find_input_format(in.format.c_str());
        if (!forced) {
            // Named and absent is a mistake worth stopping for. Falling back to
            // probing would open the file, decode something, and never mention
            // that the demuxer asked for is not in this build.
            if (err) *err = "no demuxer called '" + in.format + "' in this build";
            return false;
        }
    }

    AVDictionary* opts = nullptr;
    for (const auto& o : in.options)
        if (!o.key.empty()) av_dict_set(&opts, o.key.c_str(), o.value.c_str(), 0);

    const int rc = avformat_open_input(out, in.path.c_str(), forced, &opts);
    if (rc < 0) {
        av_dict_free(&opts);
        *out = nullptr;
        if (err) *err = in.path + ": " + avErr(rc);
        return false;
    }

    // What libavformat hands back in the dictionary is what nothing consumed —
    // not the demuxer, not the protocol, not libavformat's own generic table.
    // That is the only reliable "was this option used?" in libav, and a render
    // or a playback that succeeded while ignoring what it was told is the worst
    // of the three outcomes.
    if (opts && av_dict_count(opts) > 0) {
        std::string names;
        const AVDictionaryEntry* e = nullptr;
        while ((e = av_dict_iterate(opts, e)))
            names += (names.empty() ? "" : ", ") + std::string(e->key);
        av_dict_free(&opts);
        avformat_close_input(out);
        if (err)
            *err = in.path + ": " +
                   (names.find(',') == std::string::npos ? "no option called '"
                                                         : "no options called '") +
                   names + "' on " +
                   (in.format.empty() ? "this demuxer" : in.format);
        return false;
    }
    av_dict_free(&opts);

    const int info = avformat_find_stream_info(*out, nullptr);
    if (info < 0) {
        avformat_close_input(out);
        if (err) *err = in.path + ": " + avErr(info);
        return false;
    }
    return true;
}

double inputEpoch(const MediaInput& in, double containerStart) {
    // A timestamp is turned into this input's own clock by subtracting this.
    // `ss` moves the zero forward into the file; `itsoffset` moves the content
    // later, which is the same arithmetic with the other sign.
    return containerStart + in.ss - in.itsoffset;
}

double inputLimit(const MediaInput& in) {
    return in.duration > 0.0 ? in.duration + in.itsoffset : 0.0;
}

std::string inputToken(const std::string& id) {
    return std::string(kPrefix) + id;
}

std::string defineInput(const std::string& id, const MediaInput& in) {
    {
        std::lock_guard<std::mutex> g(lock());
        table()[id] = in;
    }
    return inputToken(id);
}

void forgetInput(const std::string& id) {
    std::lock_guard<std::mutex> g(lock());
    table().erase(id);
}

bool resolveToken(const std::string& src, MediaInput* out) {
    const std::string prefix(kPrefix);
    if (src.compare(0, prefix.size(), prefix) != 0) return false;
    std::lock_guard<std::mutex> g(lock());
    auto it = table().find(src.substr(prefix.size()));
    if (it == table().end()) return false;
    if (out) *out = it->second;
    return true;
}

} // namespace ffmpegbro
