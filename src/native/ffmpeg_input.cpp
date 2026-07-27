// An input is an `-i`. See ffmpeg_input.h.

#include "ffmpeg_input.h"

#include "export_frame.h"       // avErr
#include "ffmpeg_capabilities.h"  // isInputDevice

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/dict.h>
}

#include <algorithm>
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

bool openDecoder(AVCodecContext** out, const AVCodecParameters* par,
                 AVRational pktTimeBase, const MediaInput& in, bool threaded,
                 std::string* err) {
    if (!out) return false;
    *out = nullptr;
    if (!par) return false;

    const AVCodec* codec = avcodec_find_decoder(par->codec_id);
    if (!codec) {
        if (err) *err = in.path + ": this build has no " +
                        avcodec_get_name(par->codec_id) + " decoder";
        return false;
    }

    AVCodecContext* ctx = avcodec_alloc_context3(codec);
    if (!ctx) { if (err) *err = "out of memory"; return false; }
    if (avcodec_parameters_to_context(ctx, par) < 0) {
        avcodec_free_context(&ctx);
        if (err) *err = in.path + ": that stream cannot be described to its decoder";
        return false;
    }
    ctx->pkt_timebase = pktTimeBase;
    if (threaded) {
        ctx->thread_count = 0;
        ctx->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
    }

    // Applied through the dictionary rather than av_opt_set, because a
    // dictionary is the one call that reports back what nothing understood —
    // the same reason `openInput` above uses one for the demuxer's options.
    AVDictionary* opts = nullptr;
    for (const auto& o : in.decoderOptions)
        if (!o.key.empty()) av_dict_set(&opts, o.key.c_str(), o.value.c_str(), 0);

    const int rc = avcodec_open2(ctx, codec, &opts);
    if (rc < 0) {
        av_dict_free(&opts);
        avcodec_free_context(&ctx);
        if (err) *err = in.path + ": cannot open the " + codec->name +
                        " decoder: " + avErr(rc);
        return false;
    }
    if (opts && av_dict_count(opts) > 0) {
        std::string names;
        const AVDictionaryEntry* e = nullptr;
        while ((e = av_dict_iterate(opts, e)))
            names += (names.empty() ? "" : ", ") + std::string(e->key);
        av_dict_free(&opts);
        avcodec_free_context(&ctx);
        if (err)
            *err = in.path + ": the " + codec->name + " decoder has no option '" +
                   names + "'";
        return false;
    }
    av_dict_free(&opts);

    *out = ctx;
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

bool inputIsEndless(const MediaInput& in) {
    if (in.streamLoop != 0) return true;
    // A device does not end. A camera, a screen grabber and a sound card go on
    // producing for as long as they are asked to, and libavformat reports no
    // duration for any of them — which is the same *state* an unplayed still
    // is in and a completely different *fact*: a still has one picture and
    // nobody has said how long to hold it, and a device has no last picture at
    // all. Both come out here, because what everything above the model needs
    // to know is the same in both cases: `-t` is the only thing that can say
    // how long this input is.
    if (isInputDevice(in.format)) return true;
    // `-loop 1` is the `image2` demuxer's own option and travels in the bag,
    // which is right — it is exactly what the command line says and exactly
    // what `av_dict_set` is handed. So this reads the bag rather than a field
    // of its own: a second field would be a second place to say the same thing
    // and the two would eventually disagree.
    for (const auto& o : in.options)
        if (o.key == "loop" && !o.value.empty() && o.value != "0") return true;
    return false;
}

double inputDuration(const MediaInput& in, double containerDuration) {
    double measured = containerDuration > 0.0 ? containerDuration : 0.0;
    // A finite `-stream_loop` is the file over again a known number of times,
    // which is measurable and useful: `-stream_loop 1` on ten seconds is
    // twenty. `-stream_loop -1` and `-loop 1` are not measurable at all —
    // libavformat reports one pass, or for a still one frame — so nothing that
    // was measured says how long they are.
    if (in.streamLoop > 0) measured *= double(in.streamLoop) + 1.0;
    else if (inputIsEndless(in)) measured = 0.0;

    // Nothing measurable. `-t` is the whole answer and without one nobody
    // knows, which is a truth worth reporting rather than a zero to be
    // replaced further up with a number nobody chose.
    if (measured <= 0.0) return inputLimit(in);

    const double limit = inputLimit(in);
    double d = measured - in.ss + in.itsoffset;
    if (limit > 0.0) d = std::min(d, limit);
    return std::max(0.0, d);
}

// ── -stream_loop ───────────────────────────────────────────────────────────

void InputLoop::configure(AVFormatContext* fmt, const MediaInput& in) {
    passes_ = in.streamLoop < 0 ? 0 : int64_t(in.streamLoop) + 1;
    done_ = 0;
    shift_ = 0;
    furthest_ = 0;
    passLen_ = fmt && fmt->duration != AV_NOPTS_VALUE && fmt->duration > 0 ? fmt->duration : 0;
}

int InputLoop::read(AVFormatContext* fmt, AVPacket* pkt) {
    for (;;) {
        const int rc = av_read_frame(fmt, pkt);
        if (rc >= 0) {
            AVStream* st = fmt->streams[pkt->stream_index];
            if (passes_ != 1) {
                // How long a pass is, measured, for the formats that will not
                // say: the furthest a packet reached. Taken on every pass and
                // not only the first, because a demuxer that reports nothing
                // reports nothing consistently and the answer only improves.
                const int64_t ts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
                if (ts != AV_NOPTS_VALUE) {
                    const int64_t end = av_rescale_q(ts + std::max<int64_t>(pkt->duration, 0),
                                                     st->time_base, AV_TIME_BASE_Q) - shift_;
                    if (end > furthest_) furthest_ = end;
                }
                if (shift_) {
                    const int64_t d = av_rescale_q(shift_, AV_TIME_BASE_Q, st->time_base);
                    if (pkt->pts != AV_NOPTS_VALUE) pkt->pts += d;
                    if (pkt->dts != AV_NOPTS_VALUE) pkt->dts += d;
                }
            }
            return rc;
        }
        if (rc != AVERROR_EOF) return rc;

        done_++;
        if (passes_ != 0 && done_ >= passes_) return AVERROR_EOF;

        const int64_t len = passLen_ > 0 ? passLen_ : furthest_;
        if (len <= 0) return AVERROR_EOF;   // nothing measurable; one pass is all there is
        // Seeking to before the beginning rather than to zero: a container
        // whose first timestamp is not zero would otherwise start the second
        // pass a little into itself.
        const int rs = avformat_seek_file(fmt, -1, INT64_MIN, INT64_MIN, INT64_MIN, 0);
        if (rs < 0) return AVERROR_EOF;
        shift_ += len;
    }
}

void InputLoop::seekTo(double seconds, double* within) {
    if (within) *within = seconds;
    if (passes_ == 1) return;
    const int64_t len = passLen_ > 0 ? passLen_ : furthest_;
    if (len <= 0) return;
    const double passSeconds = double(len) / double(AV_TIME_BASE);
    int64_t pass = int64_t(seconds / passSeconds);
    if (pass < 0) pass = 0;
    if (passes_ != 0 && pass > passes_ - 1) pass = passes_ - 1;
    done_ = pass;
    shift_ = pass * len;
    if (within) *within = seconds - double(pass) * passSeconds;
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
