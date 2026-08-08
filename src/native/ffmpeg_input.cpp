// An input is an `-i`. See ffmpeg_input.h.

#include "ffmpeg_input.h"

#include "export_frame.h"       // avErr
#include "ffmpeg_capabilities.h"  // isInputDevice
#include "ffmpeg_hardware.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/dict.h>
#include <libavutil/frame.h>
#include <libavutil/pixdesc.h>
#include <libavutil/time.h>
}

#include <algorithm>
#include <cmath>
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

/// libavcodec asking which of the formats it could produce we want.
///
/// The wanted format travels in `AVCodecContext::opaque`, which libavcodec
/// itself never touches and which ffmpeg's own CLI uses for exactly this.
///
/// **Returning `AV_PIX_FMT_NONE` rather than the first software format is the
/// refusal.** libavcodec's documented behaviour on a `get_format` that offers
/// nothing is to fail the decode, and that is the right outcome: the caller
/// asked for a hardware decode, and a decoder that quietly produced software
/// frames instead would be a render that ignored what it was told. The common
/// version of this — a codec the card has no decoder for — is caught at
/// `openDecoder` below, before a packet is read, which is where it can be said
/// in a sentence.
AVPixelFormat wantedHwFormat(AVCodecContext* ctx, const AVPixelFormat* offered) {
    const auto want = static_cast<AVPixelFormat>(
        static_cast<int>(reinterpret_cast<intptr_t>(ctx->opaque)));
    for (const AVPixelFormat* p = offered; p && *p != AV_PIX_FMT_NONE; ++p)
        if (*p == want) return *p;
    return AV_PIX_FMT_NONE;
}

/// Which decoder this input's video stream is opened with.
///
/// libavcodec's own answer for every input that asks for nothing, which is all
/// of them but one: an input that names an `-hwaccel` is asking for the picture
/// to be made on a device, and **the decoder a codec's default is not always one
/// that can be**. `hwDecoderFor` is where that is decided and why; the fallback
/// here is deliberate rather than a refusal, because the message `attachDevice`
/// gives for a codec no decoder can put on the card is the better one.
const AVCodec* decoderFor(AVCodecID id, const MediaInput& in) {
    if (!in.hwaccel.empty()) {
        const AVHWDeviceType type = hwTypeNamed(in.hwaccel);
        if (const AVCodec* hw = hwDecoderFor(id, type, nullptr)) return hw;
    }
    return avcodec_find_decoder(id);
}

/// The device this input asks for, on this decoder, or a sentence saying why
/// not. Leaves the context untouched when the input asks for nothing.
bool attachDevice(AVCodecContext* ctx, const AVCodec* codec, const MediaInput& in,
                  std::string* err) {
    if (in.hwaccel.empty()) return true;

    const AVHWDeviceType type = hwTypeNamed(in.hwaccel);
    if (type == AV_HWDEVICE_TYPE_NONE) {
        if (err) *err = in.path + ": this build has no hardware acceleration called '" +
                        in.hwaccel + "'";
        return false;
    }

    // "The card is there" and "the card can decode *this*" are different
    // questions and only the second one matters. Asked before a device is made,
    // because the answer is a property of the build and the codec and does not
    // need a driver to be consulted.
    //
    // Of *this* decoder, which is the one `decoderFor` has already chosen for
    // the device — so what this catches is the codec the card genuinely cannot
    // decode, and the message names the codec rather than whichever decoder of
    // it happened to be the default.
    AVPixelFormat hwFmt = AV_PIX_FMT_NONE;
    if (!decoderTakesDevice(codec, type, &hwFmt)) {
        if (err)
            *err = in.path + ": " + in.hwaccel + " cannot decode " +
                   avcodec_get_name(codec->id) +
                   " in this build — no " + avcodec_get_name(codec->id) +
                   " decoder reports an " + in.hwaccel +
                   " configuration, so the picture would have to come off the CPU anyway";
        return false;
    }

    std::string why;
    AVBufferRef* device = hwDeviceRef(in.hwaccel, in.hwaccelDevice, &why);
    if (!device) {
        if (err) *err = in.path + ": " + why;
        return false;
    }

    // A caller that named an output format has to have named *this* one: the
    // frames a decoder makes on a device are in the device's format and nothing
    // converts them on the way out. Checked here so that a typo is a sentence
    // rather than a graph that will not configure four functions later.
    if (!in.hwaccelOutputFormat.empty()) {
        const AVPixelFormat asked = av_get_pix_fmt(in.hwaccelOutputFormat.c_str());
        if (asked != hwFmt) {
            av_buffer_unref(&device);
            const char* got = av_get_pix_fmt_name(hwFmt);
            if (err)
                *err = in.path + ": " + codec->name + " on " + in.hwaccel +
                       " produces " + (got ? got : "?") + " frames, not '" +
                       in.hwaccelOutputFormat + "'";
            return false;
        }
    }

    ctx->hw_device_ctx = device;        // the context takes the reference
    ctx->opaque = reinterpret_cast<void*>(static_cast<intptr_t>(hwFmt));
    ctx->get_format = wantedHwFormat;
    return true;
}

/// Why the open failed, in the caller's terms rather than libav's.
///
/// An interrupted open comes back as `AVERROR_EXIT`, whose message is
/// "Immediate exit requested" — which names the mechanism and says nothing
/// about the reason. There are two reasons and they are different answers to
/// what to do next: a deadline that expired means the far end is not answering,
/// and a stop means somebody said so. Anything else is libav's own message,
/// unchanged.
std::string openFailure(int rc, const OpenWatch* watch) {
    if (watch && watch->stopped()) return "stopped";
    if (watch && watch->expired()) return "no answer in time";
    return avErr(rc);
}

} // namespace

void OpenWatch::expireIn(double seconds) {
    deadline_.store(seconds > 0 ? av_gettime_relative() +
                                      static_cast<int64_t>(seconds * 1e6)
                                : 0,
                    std::memory_order_relaxed);
}

void OpenWatch::stop() { stop_.store(true, std::memory_order_relaxed); }

int OpenWatch::poll(void* opaque) {
    auto* self = static_cast<OpenWatch*>(opaque);
    if (!self) return 0;
    if (self->stop_.load(std::memory_order_relaxed)) return 1;
    const int64_t deadline = self->deadline_.load(std::memory_order_relaxed);
    // The flag is set here and not merely computed, because "did the deadline
    // stop this?" is asked after the open has failed and by then the clock has
    // gone past it either way. Only a callback that actually answered "give up"
    // may claim to be the reason.
    if (deadline && av_gettime_relative() >= deadline) {
        self->expired_.store(true, std::memory_order_relaxed);
        return 1;
    }
    return 0;
}

bool openInput(AVFormatContext** out, const MediaInput& in, std::string* err,
               OpenWatch* watch) {
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

    // The context is ours to allocate when somebody is watching, because
    // `interrupt_callback` has to be set before the first byte is read and
    // `avformat_open_input` allocates one too late for that. It frees whatever
    // it was given on failure, so there is nothing to clean up here that is not
    // cleaned up either way.
    if (watch) {
        *out = avformat_alloc_context();
        if (!*out) {
            av_dict_free(&opts);
            if (err) *err = in.path + ": out of memory";
            return false;
        }
        (*out)->interrupt_callback.callback = &OpenWatch::poll;
        (*out)->interrupt_callback.opaque = watch;
    }

    const int rc = avformat_open_input(out, in.path.c_str(), forced, &opts);
    if (rc < 0) {
        av_dict_free(&opts);
        *out = nullptr;
        if (err) *err = in.path + ": " + openFailure(rc, watch);
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

    // **`avformat_find_stream_info` answers success when the callback cut it
    // short**, which is measured and is not what the name suggests: told to
    // give up on its first poll it returns 0 in 0.04 ms, having learned
    // whatever `read_header` had already put in the streams. So the watch is
    // asked as well as the return code — otherwise a deadline that expired
    // here would produce a *successful* probe of a half-analysed file, which
    // is the one outcome worse than the hang this deadline exists to end. It
    // matters most for a device, where this call is 57–99.9% of the open and
    // the only half a deadline can reach at all.
    const int info = avformat_find_stream_info(*out, nullptr);
    if (info < 0 || (watch && (watch->stopped() || watch->expired()))) {
        avformat_close_input(out);
        if (err) *err = in.path + ": " + openFailure(info, watch);
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

    const AVCodec* codec = decoderFor(par->codec_id, in);
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

    // `-hwaccel` is a decision about the picture and about nothing else. An
    // input carrying one still opens its sound with libavcodec's own decoder,
    // which is what ffmpeg does and the only thing that could be meant: there
    // is no hardware AAC decoder and asking for one would refuse every file
    // with a soundtrack.
    if (par->codec_type == AVMEDIA_TYPE_VIDEO &&
        !attachDevice(ctx, codec, in, err)) {
        avcodec_free_context(&ctx);
        return false;
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

bool hwFramesStayUp(const MediaInput& in) {
    return !in.hwaccel.empty() && !in.hwaccelOutputFormat.empty();
}

bool downloadFrame(AVFrame** frame, AVFrame** scratch, std::string* err) {
    if (!frame || !*frame || !scratch || !*scratch) return false;
    if (!(*frame)->hw_frames_ctx) return true;      // already in system memory

    av_frame_unref(*scratch);
    // Left at NONE so libavutil picks the first format the device can transfer
    // into — nv12 for CUDA and for QSV, and whatever a build with 10-bit
    // surfaces reports first. Naming one here would be a table of what each
    // device produces, and it would be wrong for the first 10-bit file.
    (*scratch)->format = AV_PIX_FMT_NONE;
    const int rc = av_hwframe_transfer_data(*scratch, *frame, 0);
    if (rc < 0) {
        if (err) *err = "cannot bring a frame down off the device: " + avErr(rc);
        return false;
    }
    // Pixels are all `transfer_data` moves. Without this the picture arrives
    // with no pts, no colour tags and none of the metadata a measuring filter
    // hung on it — which reads as a decoder that has stopped reporting
    // timestamps rather than as a missing line here.
    av_frame_copy_props(*scratch, *frame);
    // The caller goes on holding the picture in `frame` and the spare in
    // `scratch`, which is what makes the next download free of an allocation.
    std::swap(*frame, *scratch);
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

int64_t inputSeekTarget(AVRational timeBase, const MediaInput& in, double at) {
    return static_cast<int64_t>(std::llround((at + in.ss - in.itsoffset) / av_q2d(timeBase)));
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
