// Recording live inputs. See ffmpeg_capture.h for why this is a second job
// rather than a flag on the render, for what the filter graph in the middle of
// it is and is not, and for the two clocks a session can run on.

#include "ffmpeg_capture.h"

#include "capture_graph.h"
#include "export_frame.h"
#include "export_writer.h"
#include "ffmpeg_job.h"
#include "live_tap.h"
#include "ffmpeg_report.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
#include <libavutil/rational.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include "util/log.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace ffmpegbro {

namespace {

using Clock = std::chrono::steady_clock;

/// Every input this recording reads.
///
/// **An empty `sources` is `{source}`**, which is the rule `outputStreams()`
/// and `ExportSettings::inputs` already follow: a caller that never heard of
/// the list means exactly what it always meant. One place, so nothing
/// downstream has to ask which of the two fields it is looking at.
std::vector<MediaInput> sourcesOf(const CaptureSettings& s) {
    if (!s.sources.empty()) return s.sources;
    return {s.source};
}

/// How long the session is, in seconds, or zero for until stopped.
///
/// `-t` belongs to an input, and with several of them the **shortest** decides:
/// an input that has run out has nothing further to offer the graph, so going
/// on would be recording whatever is left of the others over a picture held
/// still. With one input this is that input's `-t` and nothing has changed.
double limitOf(const std::vector<MediaInput>& srcs) {
    double best = 0.0;
    for (const auto& in : srcs)
        if (in.duration > 0.0 && (best <= 0.0 || in.duration < best)) best = in.duration;
    return best;
}

/// One open device: its demuxer, the two decoders it might have, and the
/// converters into the currency the writer takes.
///
/// It is not a `SourceVideo` and a `SourceAudio` because those own a demuxer
/// each, and one device is one demuxer: `-f dshow -i "video=Camera:audio=Mic"`
/// is a single `-i` carrying both, and opening it twice would open the camera
/// twice — which on Windows is not a slow path, it is an error.
///
/// **One of these per input, and in a session one reader thread per one of
/// these.** Everything in here is touched by that thread alone once the session
/// is running, which is what makes the decoders and the packet and frame
/// scratch safe without a lock around any of them.
struct Device {
    MediaInput in;
    int index = 0;              ///< the number in `[<index>:v]`

    AVFormatContext* fmt = nullptr;
    AVPacket* pkt = nullptr;
    AVFrame* frame = nullptr;

    int videoStream = -1;
    int audioStream = -1;
    AVCodecContext* vdec = nullptr;
    AVCodecContext* adec = nullptr;

    SwsContext* toRgba = nullptr;
    AVPixelFormat swsFmt = AV_PIX_FMT_NONE;
    SwrContext* swr = nullptr;
    AVChannelLayout outLayout{};

    /// What this device offers a graph, and what a session waits for.
    bool hasVideo() const { return vdec != nullptr; }
    bool hasAudio() const { return adec != nullptr; }
    std::string name() const {
        return in.format.empty() ? in.path : in.format + " " + in.path;
    }

    ~Device() {
        if (toRgba) sws_freeContext(toRgba);
        if (swr) swr_free(&swr);
        av_channel_layout_uninit(&outLayout);
        if (frame) av_frame_free(&frame);
        if (pkt) av_packet_free(&pkt);
        if (vdec) avcodec_free_context(&vdec);
        if (adec) avcodec_free_context(&adec);
        if (fmt) avformat_close_input(&fmt);
    }
};

using DeviceList = std::vector<std::shared_ptr<Device>>;

bool openDecoder(AVFormatContext* fmt, int index, AVCodecContext** out, std::string* err) {
    AVStream* st = fmt->streams[index];
    const AVCodec* codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) {
        if (err) *err = std::string("no decoder for ") +
                        avcodec_get_name(st->codecpar->codec_id);
        return false;
    }
    AVCodecContext* dec = avcodec_alloc_context3(codec);
    if (!dec || avcodec_parameters_to_context(dec, st->codecpar) < 0) {
        // The allocation may well have succeeded and only the copy failed, in
        // which case there is a context to give back. The `avcodec_open2`
        // branch below already gets this right.
        if (dec) avcodec_free_context(&dec);
        if (err) *err = "could not set up the decoder";
        return false;
    }
    dec->thread_count = 0;
    dec->pkt_timebase = st->time_base;
    const int rc = avcodec_open2(dec, codec, nullptr);
    if (rc < 0) {
        avcodec_free_context(&dec);
        if (err) *err = avErr(rc);
        return false;
    }
    *out = dec;
    return true;
}

/// Open one device and settle everything about *it* that has to be known
/// before the file can be: whether there are pictures, whether there is sound,
/// and how that sound becomes the recording's.
///
/// What the *output* takes from the devices — the picture size and the rate —
/// is `settleOutput` below, because with several inputs that is a decision
/// about the list rather than about any one of them.
bool openDevice(Device& d, const MediaInput& in, int index, const CaptureSettings& s,
                std::string* err) {
    d.in = in;
    d.index = index;
    if (!openInput(&d.fmt, in, err)) return false;

    d.videoStream = av_find_best_stream(d.fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    d.audioStream = av_find_best_stream(d.fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (d.videoStream < 0 && d.audioStream < 0) {
        *err = in.path + ": this device produced neither pictures nor sound";
        return false;
    }

    if (d.videoStream >= 0) {
        std::string why;
        if (!openDecoder(d.fmt, d.videoStream, &d.vdec, &why)) {
            *err = in.path + ": " + why;
            return false;
        }
    }

    if (d.audioStream >= 0 && s.output.includeAudio) {
        std::string why;
        if (!openDecoder(d.fmt, d.audioStream, &d.adec, &why)) {
            // Sound this build cannot decode is not a reason to refuse the
            // recording: the picture is usually the point, and a capture that
            // refused to start would lose it entirely.
            LOG_WARN("capture: %s, recording without sound", why.c_str());
            reportNote(AV_LOG_WARNING, "capture", why + ", recording without sound");
            d.audioStream = -1;
        }
    } else {
        d.audioStream = -1;
    }

    if (d.adec) {
        av_channel_layout_default(&d.outLayout, std::max(1, s.output.audioChannels));
        const int rc = swr_alloc_set_opts2(
            &d.swr, &d.outLayout, AV_SAMPLE_FMT_FLT, s.output.audioSampleRate,
            &d.adec->ch_layout, d.adec->sample_fmt, d.adec->sample_rate, 0, nullptr);
        if (rc < 0 || !d.swr || swr_init(d.swr) < 0) {
            *err = "could not set up the resampler for this device's sound";
            return false;
        }
    }

    d.pkt = av_packet_alloc();
    d.frame = av_frame_alloc();
    if (!d.pkt || !d.frame) { *err = "out of memory"; return false; }
    return true;
}

/// What size and rate the file is opened for, before the graph has said
/// otherwise.
///
/// **The first input that has a picture decides**, which for one device is the
/// device and for a session is the one the others are composited onto — the
/// order the sources were given in is the order the graph numbers them, so it
/// is also the order somebody wrote their overlay in. A graph that says
/// otherwise still wins: a pad's size is asked for once the graph is
/// configured, in `Output::open`.
///
/// **Per file, because each of them answers it for itself.** A second file that
/// says nothing about its size is the device's size too — the same rule, asked
/// again — and one that names a size keeps it. The alternative was settling the
/// first and copying it onto the rest, which would have made "nothing said" and
/// "the same as the master" the same thing, and they are not: a proxy is
/// written at a size somebody chose and a second copy of the camera is not.
void settleOutput(ExportSettings& out, const DeviceList& devs) {
    const Device* picture = nullptr;
    for (const auto& d : devs) if (d->hasVideo()) { picture = d.get(); break; }

    if (picture) {
        // The device's own picture is the output picture unless somebody said
        // otherwise. A capture is not composited — there is no canvas to fit
        // it into — so a size of this application's choosing would be a scale
        // nobody asked for on every frame. A filter graph *is* somebody saying
        // otherwise, and the composite pad's size wins once it is configured.
        if (out.width <= 0 || out.height <= 0) {
            out.width = picture->vdec->width;
            out.height = picture->vdec->height;
        }
        if (out.fps <= 0.0) {
            const AVRational r = av_guess_frame_rate(
                picture->fmt, picture->fmt->streams[picture->videoStream], nullptr);
            out.fps = r.num > 0 && r.den > 0 ? av_q2d(r) : 30.0;
        }
    } else {
        // Sound only. The writer still wants a canvas size and a rate for the
        // video stream it is not going to open; nothing reads them.
        if (out.width <= 0) out.width = 16;
        if (out.height <= 0) out.height = 16;
        if (out.fps <= 0.0) out.fps = 30.0;
    }
    // yuv420p has no half pixels, and an odd canvas fails at avcodec_open2
    // with an unhelpful message.
    out.width = std::max(16, out.width & ~1);
    out.height = std::max(16, out.height & ~1);
}

/// What these devices can offer a filter graph, in the order that numbers them.
std::vector<CaptureGraph::FeedSource> feedsOf(const DeviceList& devs) {
    std::vector<CaptureGraph::FeedSource> out;
    out.reserve(devs.size());
    for (size_t i = 0; i < devs.size(); ++i) {
        CaptureGraph::FeedSource f;
        f.index = static_cast<int>(i);
        f.hasVideo = devs[i]->hasVideo();
        f.hasAudio = devs[i]->hasAudio();
        out.push_back(f);
    }
    return out;
}

/// One decoded picture as RGBA at the output size. The direct path's, where
/// there is no graph to have done it already.
const Rgba* toCanvas(Device& d, const AVFrame* f, Rgba& canvas, int w, int h) {
    if (f->width <= 0 || f->height <= 0) return nullptr;
    const auto fmt = static_cast<AVPixelFormat>(f->format);
    d.toRgba = sws_getCachedContext(d.toRgba, f->width, f->height, fmt, w, h,
                                    AV_PIX_FMT_RGBA, SWS_BICUBIC, nullptr, nullptr, nullptr);
    if (!d.toRgba) return nullptr;
    if (fmt != d.swsFmt) {
        setColorspace(d.toRgba, swsSpaceFor(f->colorspace, f->height),
                      f->color_range == AVCOL_RANGE_JPEG ? 1 : 0, SWS_CS_ITU709, 1);
        d.swsFmt = fmt;
    }
    canvas.resize(w, h);
    uint8_t* dst[4] = {canvas.data.data(), nullptr, nullptr, nullptr};
    int stride[4] = {canvas.stride, 0, 0, 0};
    if (sws_scale(d.toRgba, f->data, f->linesize, 0, f->height, dst, stride) <= 0)
        return nullptr;
    return &canvas;
}

/// One picture the recording writes: where it goes, and where it has got to.
///
/// **Per destination and not per recording**, because a graph can end in several
/// pads and each of them is a picture in its own right — arriving at its own
/// rate, stalling on its own, and holding its own last frame over a gap. One
/// `nextIndex` between them would have a fast pad dragging a slow one's
/// timestamps along with it.
struct VidDest {
    bool composite = false;     ///< `writeVideo`, which feeds every composite stream
    size_t desc = 0;            ///< otherwise `writeVideoTo`, by resolved index
    std::string label;          ///< the pad it reads; empty for the composite
    Rgba held;
    bool haveHeld = false;
    int64_t next = 0;
};

/// The same for a soundtrack. There is no held-last-block here: silence in a
/// recording is silence, and the writer's fifo already accounts for what it has
/// been given.
struct AudDest {
    bool mix = false;           ///< `writeAudio`, which feeds every mix-fed stream
    size_t desc = 0;
    std::string label;
    int64_t written = 0;
};

/// Everything downstream of the graph for **one file**: its writer, one
/// destination per pad it maps, and the rules that place what arrives.
///
/// It is shared by both of the loops below because **neither of them changes
/// what happens to a frame once it has left the graph** — a session and a
/// single device differ entirely in how frames are got hold of, and not at all
/// in where they go. Keeping that in one object is what stops the wall-clock
/// loop growing a second, slightly different, answer to `-t`.
///
/// **One of these per file, and a recording can be asked for several** — see
/// `Files` below and `CaptureSettings::outputs`. What belongs to the session
/// rather than to the file is held by reference or by `Files`: the graph, the
/// status, the limit, and the one `stop` that ends every file together, because
/// a recording that half failed is a recording that failed.
struct Output {
    ExportSettings& cfg;
    ExportStatus& st;
    CaptureGraph* graph = nullptr;
    bool& stop;

    /// Zero means until stopped. It is `-t` on the input, which is where a
    /// command line puts it — and it is judged on *output* time, so a graph
    /// that changes the rate still records the number of seconds asked for.
    /// The session's, copied in: `place` reads it per frame.
    double limit = 0.0;
    /// Is a picture going to arrive at all? It decides what happens to sound
    /// that turns up before one: dropped, because letting it in would put the
    /// whole soundtrack ahead of the picture by however long the device took to
    /// wake up.
    bool expectsPicture = true;
    /// Only for a recording with no graph, where there is one device and the
    /// question is whether it had a soundtrack.
    bool deviceHasAudio = false;
    /// The file the recording's frame count and its `-t` percentage are about.
    /// True for `outputs[0]` and nothing else: a counter that jumped between
    /// two files' clocks would be a counter about neither.
    bool primary = true;
    /// **Did this file name a size, before `settleOutput` filled the blanks?**
    /// Recorded in the constructor because that is the last moment the two are
    /// distinguishable, and they have to be: a pad's settled size is the right
    /// answer for a file that said nothing and is exactly the wrong one for a
    /// proxy, which exists to be another size.
    bool sizeAsked = false;

    Writer writer;
    std::vector<VidDest> vids;
    std::vector<AudDest> auds;
    AudDest* mixDest = nullptr;
    bool opened = false;
    double epoch = -1.0;        ///< the first picture's timestamp; this file's zero
    std::string err;

    Output(ExportSettings& settings, ExportStatus& status, CaptureGraph* g, bool& stopping)
        : cfg(settings), st(status), graph(g), stop(stopping) {}

    /// **The file is opened for what the graph turned out to produce.** A pad's
    /// size is not knowable until libavfilter has configured the graph, and the
    /// graph is not configured until a device has handed over a frame — so with
    /// a graph this runs on the first frame rather than up front, which is the
    /// one ordering difference between a recording and a render on this path.
    bool open(std::string* why);

    bool writeOne(VidDest& v, const Rgba& pic, int64_t n);
    /// Where this picture belongs, and everything owed before it. False when
    /// the recording is over — the limit was reached, or a write failed.
    bool place(VidDest& v, double at, const Rgba& pic);
    bool writeSound(AudDest& a, double at, const float* samples, int frames);
    /// One frame off one pad of the graph, to every destination reading it. A
    /// pad read both as the composite and by name is one sink written twice,
    /// which for a picture is simply the same picture in two streams.
    bool emit(const CaptureGraph::Taken& tk);
};

bool Output::open(std::string* why) {
    if (graph) {
        if (const int w = graph->compositeWidth(); w > 0 && !sizeAsked) {
            cfg.width = std::max(16, w & ~1);
            cfg.height = std::max(16, graph->compositeHeight() & ~1);
        }
        if (const double r = graph->compositeRate(); r > 0.0 && primary) cfg.fps = r;
        if (primary && limit > 0.0)
            st.framesTotal = std::max<int64_t>(1, std::llround(limit * cfg.fps));
    }

    const bool wantAudio = graph ? graph->hasMix() : deviceHasAudio;
    std::vector<ExportStream> resolved = outputStreams(cfg, wantAudio);
    std::vector<std::string> reads;
    // The same refusals a render makes about `pad:`, in the same words: the
    // moment differs because a recording learns its pad sizes late, and the
    // answers must not.
    if (!resolvePads(cfg, graph, resolved, &reads, why)) return false;
    if (graph) {
        graph->readPads(reads);
        if (!reads.empty()) resolved = outputStreams(cfg, wantAudio);
    }
    if (!writer.open(cfg, wantAudio, why)) return false;
    opened = true;

    // The composite first, so that `vids.front()` is the picture the recording's
    // frame count and its `-t` are about.
    for (const auto& r : resolved)
        if (r.kind == "video" && r.source == "composite") {
            VidDest v;
            v.composite = true;
            vids.push_back(std::move(v));
            break;
        }
    for (size_t i = 0; i < resolved.size(); ++i) {
        const ExportStream& r = resolved[i];
        if (!isPadSource(r.source)) continue;
        if (r.kind == "video") {
            VidDest v;
            v.desc = i;
            v.label = padLabelOf(r.source);
            vids.push_back(std::move(v));
        } else if (r.kind == "audio") {
            AudDest a;
            a.desc = i;
            a.label = padLabelOf(r.source);
            auds.push_back(std::move(a));
        }
    }
    if (writer.hasAudio()) {
        AudDest a;
        a.mix = true;
        auds.push_back(std::move(a));
    }
    for (auto& a : auds) if (a.mix) mixDest = &a;
    return true;
}

bool Output::writeOne(VidDest& v, const Rgba& pic, int64_t n) {
    // `{n}` and no timestamp beside it: a recording's clock *is* the frame
    // count. The wall clock decides when a picture exists and `place()` above
    // fills the grid in from it, so there is no second set of times for
    // `-fps_mode vfr` to keep — see FrameAt, and ffmpeg_export.h's `fpsMode`.
    const bool ok = v.composite ? writer.writeVideo(pic, {n}, &err)
                                : writer.writeVideoTo(v.desc, pic, {n}, &err);
    if (!ok) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        stop = true;
    }
    return ok;
}

bool Output::place(VidDest& v, double at, const Rgba& pic) {
    // The recording's zero is the first picture. Sound that arrived before it
    // is sound from before the recording had anything to show.
    if (epoch < 0.0) epoch = at < 0.0 ? 0.0 : at;
    const double rel = at < 0.0 ? double(v.next) / cfg.fps : at - epoch;
    if (limit > 0.0 && rel >= limit) { stop = true; return false; }

    // Rounded to an output frame, so a device that runs a little fast or a
    // little slow still writes a file whose clock is the wall clock.
    const int64_t index = std::max<int64_t>(v.next, std::llround(rel * cfg.fps));
    // A stall holds the last picture rather than leaving a hole. Cheap because
    // the gap is rare and one frame long when it is not; a gap left open would
    // make the muxer's timestamps jump, which several players read as a corrupt
    // file.
    while (v.haveHeld && v.next < index) {
        if (!writeOne(v, v.held, v.next)) return false;
        v.next++;
    }
    if (!writeOne(v, pic, v.next)) return false;
    v.held = pic;
    v.haveHeld = true;
    v.next++;
    if (primary && &v == vids.data()) st.framesDone = v.next;
    return true;
}

bool Output::writeSound(AudDest& a, double at, const float* samples, int frames) {
    const int rate = cfg.audioSampleRate;
    const int channels = cfg.audioChannels;
    // Sound before the first picture is dropped to the sample: a whole frame of
    // it is twenty milliseconds, which is audible as a lip-sync error and is
    // exactly the kind of thing nobody finds until the recording is the only
    // copy.
    int skip = 0;
    if (epoch >= 0.0 && at >= 0.0 && at < epoch)
        skip = std::min(frames, static_cast<int>(std::llround((epoch - at) * rate)));
    else if (epoch < 0.0 && expectsPicture)
        return true;    // no picture yet; this is sound from before the recording
    else if (epoch < 0.0)
        epoch = at < 0.0 ? 0.0 : at;

    const int usable = frames - skip;
    if (usable <= 0) return true;
    const float* from = samples + static_cast<size_t>(skip) * channels;
    const bool ok = a.mix ? writer.writeAudio(from, usable, &err)
                          : writer.writeAudioTo(a.desc, from, usable, &err);
    if (!ok) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        stop = true;
        return false;
    }
    a.written += usable;
    // A recording with no picture in it is as long as its soundtrack.
    if (vids.empty() && limit > 0.0 && double(a.written) / rate >= limit) {
        stop = true;
        return false;
    }
    return true;
}

bool Output::emit(const CaptureGraph::Taken& tk) {
    if (tk.audio) {
        for (auto& a : auds) {
            if (a.mix ? !tk.primary : a.label != tk.label) continue;
            if (!writeSound(a, tk.at, tk.samples, tk.frames)) return false;
        }
    } else {
        for (auto& v : vids) {
            if (v.composite ? !tk.primary : v.label != tk.label) continue;
            if (!place(v, tk.at, *tk.picture)) return false;
        }
    }
    return !stop;
}

/// Every file this recording writes, as the one thing the loops below talk to.
///
/// **A recording is one reading of the devices and one graph; the files are
/// what is on the end of it.** So this is where the session's answers live —
/// the limit, the stop, whether anything is open yet — and each `Output` under
/// it holds only what is that file's: its writer, its pads, its size and its
/// own zero. Neither loop learns how many there are.
///
/// **They fail together and finish together.** A second file that stopped
/// writing while the first carried on would be a recording somebody has to
/// check afterwards; and the trailer of every one of them goes down whatever
/// happened, for the reason it does for one — a recording that lost its index
/// has lost the only copy of something that happened once.
struct Files {
    ExportStatus& st;
    std::vector<std::unique_ptr<Output>> all;
    bool stop = false;
    bool opened = false;
    double limit = 0.0;

    explicit Files(ExportStatus& status) : st(status) {}

    Output& first() { return *all.front(); }

    /// One `Output` per file, in the order they were asked for.
    ///
    /// `cfgs` is `CaptureSettings::outputs`, already normalised and settled;
    /// it is held by the caller because `Output` writes back into it — a pad's
    /// size arrives late and the writer is opened from the same object.
    void build(std::vector<ExportSettings>& cfgs, const std::vector<char>& sizeAsked,
               CaptureGraph* graph, bool expectsPicture, bool deviceHasAudio) {
        for (size_t i = 0; i < cfgs.size(); ++i) {
            auto o = std::make_unique<Output>(cfgs[i], st, graph, stop);
            o->limit = limit;
            o->expectsPicture = expectsPicture;
            o->deviceHasAudio = deviceHasAudio;
            o->primary = i == 0;
            o->sizeAsked = i < sizeAsked.size() && sizeAsked[i];
            all.push_back(std::move(o));
        }
    }

    /// Open every file, primary first.
    ///
    /// **The order matters for exactly one thing: the rate.** The composite
    /// pad's rate is the recording's, it is not known until the graph has
    /// configured, and every file is placed on it — two files disagreeing about
    /// which output frame a moment is would be two files disagreeing about when
    /// the recording started. A file's *size* is its own; its rate is not.
    bool open(std::string* why) {
        if (!all.front()->open(why)) return false;
        const double rate = all.front()->cfg.fps;
        for (size_t i = 1; i < all.size(); ++i) {
            all[i]->cfg.fps = rate;
            if (!all[i]->open(why)) return false;
        }
        opened = true;
        return true;
    }

    /// One frame off one pad, to every file that maps it. A file that does not
    /// is not asked and is not an error: that is what mapping means.
    bool emit(const CaptureGraph::Taken& tk) {
        for (auto& o : all) if (!o->emit(tk)) return false;
        return !stop;
    }

    /// The device's own picture, straight through — the no-graph path, where
    /// there is one pad and it has no name.
    ///
    /// The canvas was converted once, at the first file's size, and a file at
    /// another size takes the difference in its writer's scaler. Converting per
    /// file would be the better picture and N conversions off one decoded
    /// frame; a proxy is smaller than its master, so the extra step is a
    /// downscale of a downscale and the master — the one anybody keeps — is
    /// converted exactly once.
    bool direct(double at, const Rgba& pic) {
        for (auto& o : all) {
            if (o->vids.empty()) continue;
            if (!o->place(o->vids.front(), at, pic)) return false;
        }
        return !stop;
    }

    /// The same for the device's own sound.
    bool directSound(double at, const float* samples, int frames) {
        for (auto& o : all) {
            if (!o->mixDest) continue;
            if (!o->writeSound(*o->mixDest, at, samples, frames)) return false;
        }
        return !stop;
    }

    /// What the recording has written, which is the sum and not any one file's:
    /// somebody watching a capture wants to know what it is costing the disk.
    int64_t bytesSoFar() const {
        int64_t n = 0;
        for (const auto& o : all) if (o->opened) n += o->writer.bytesSoFar();
        return n;
    }
    int piecesWritten() const {
        int n = 0;
        for (const auto& o : all) if (o->opened) n += o->writer.piecesWritten();
        return n;
    }

    /// Every trailer, and the **first** failure back. Every one is attempted
    /// whatever the others did: see above.
    bool finish(std::string* err) {
        bool ok = true;
        for (auto& o : all) {
            if (!o->opened) continue;
            std::string why;
            if (!o->writer.finish(&why) && ok) { *err = why; ok = false; }
        }
        return ok;
    }
};

// ── The single-device loop: media time, in one thread ───────────────────────

/// The whole recording, as a read loop.
///
/// It is not a walk over output frames the way `runExport` is, and it cannot
/// be: the device decides when a frame exists. What this does per frame is
/// place it — turn a timestamp into an output frame number — so that what comes
/// out is constant frame rate whatever the device did, which is what every
/// editor wants and what the writer is built for.
///
/// **With a graph, placement happens after it and not before.** A frame is
/// pushed into `CaptureGraph` with the device's own timestamp on it, and what
/// is placed is what falls out of the sinks, on the clock the graph gave it. So
/// a rate-changing filter needs nothing special here: `fps=10` produces ten
/// frames a second stamped as such, and they are placed where they fall. The
/// recording's zero is still the first picture written to the composite, which
/// is why the composite sink is drained first.
///
/// **This is the one-input mode**, and it stays exactly what it was. The
/// device's own media timestamps are the clock, which is what makes a `-f
/// lavfi` input record faster than real time and a camera that drifts a little
/// still come out constant rate. There is nothing to line it up against, so
/// there is nothing for a wall clock to buy.
void runDirect(CaptureSettings& s, const std::vector<char>& sizeAsked, ExportStatus& st,
               const std::shared_ptr<Device>& dev,
               const std::function<double()>& secondsSince,
               const std::function<void(const std::string&)>& refuse) {
    Device& d = *dev;
    std::string err;

    // The graph, built here rather than where the recording was asked for, for
    // the reason the writer is: it is the thing that runs, and it is built where
    // it runs. Everything about it that could be refused was refused before this
    // thread existed — see `startCapture`.
    std::unique_ptr<CaptureGraph> graph;
    if (!s.output.filterGraph.empty()) {
        graph = std::make_unique<CaptureGraph>(s.output.filterGraph, s.output.audioSampleRate,
                                               s.output.audioChannels, s.output.scaler);
        std::vector<std::shared_ptr<Device>> one{dev};
        if (!graph->open(feedsOf(one), &err)) { refuse(err); return; }
    }
    const int vFeed = graph ? graph->feedFor(0, false) : -1;
    const int aFeed = graph ? graph->feedFor(0, true) : -1;

    Files out(st);
    out.limit = limitOf({d.in});
    // Whether the device has a picture is the whole of it: a graph can only
    // keep one or be refused for eating it (`open()` will not accept a graph
    // that reads the picture and produces none), so it cannot make the answer
    // yes where the device said no. Asking the graph as well used to, which
    // dropped every sample of a sound-only device's soundtrack — nothing was
    // ever going to set an epoch for it to be measured against.
    out.build(s.outputs, sizeAsked, graph.get(), d.hasVideo(), d.adec != nullptr);

    const auto emit = [&out](const CaptureGraph::Taken& tk) { return out.emit(tk); };

    if (!graph && !out.open(&err)) { refuse(err); return; }
    st.stage = "recording";
    job::publish(st);

    Rgba canvas;
    std::vector<float> samples;
    const int rate = s.output.audioSampleRate;
    const int channels = s.output.audioChannels;

    const auto stamp = [&](int stream, const AVFrame* f) {
        const int64_t ts = f->best_effort_timestamp != AV_NOPTS_VALUE
                               ? f->best_effort_timestamp : f->pts;
        if (ts == AV_NOPTS_VALUE) return -1.0;
        return ts * av_q2d(d.fmt->streams[stream]->time_base);
    };

    while (!out.stop) {
        if (job::stopping()) break;

        av_packet_unref(d.pkt);
        const int rc = av_read_frame(d.fmt, d.pkt);
        if (rc == AVERROR(EAGAIN)) continue;   // a device with nothing yet
        if (rc < 0) {
            // A device ending is not an error — lavfi with a bounded graph
            // does it, and so does a camera being unplugged. Whatever was
            // recorded is a recording.
            if (rc != AVERROR_EOF) {
                LOG_WARN("capture: %s", avErr(rc).c_str());
                reportNote(AV_LOG_WARNING, "capture", "the device stopped: " + avErr(rc));
            }
            break;
        }

        const bool isVideo = d.pkt->stream_index == d.videoStream && d.vdec;
        const bool isAudio = d.pkt->stream_index == d.audioStream && d.adec;
        if (!isVideo && !isAudio) continue;

        AVCodecContext* dec = isVideo ? d.vdec : d.adec;
        if (avcodec_send_packet(dec, d.pkt) < 0) continue;

        while (!out.stop) {
            if (avcodec_receive_frame(dec, d.frame) < 0) break;
            const int feed = isVideo ? vFeed : aFeed;

            // Into the graph, and then out of every sink until it says EAGAIN.
            // Push and drain, never pull: nothing here may ask an input for a
            // frame, because the input is a device and the answer is "when it
            // happens".
            if (graph && feed >= 0) {
                if (!graph->push(feed, d.frame,
                                 d.fmt->streams[d.pkt->stream_index]->time_base, &err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    out.stop = true;
                    break;
                }
                if (graph->ready() && !out.opened && !out.open(&err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    out.stop = true;
                    break;
                }
                // `emit` refuses when the recording is over, and it has already
                // said which of the two reasons it was.
                if (out.opened && !graph->drain(emit, &err)) out.stop = true;
                continue;
            }

            // Straight to the writer: this stream of the device is one the graph
            // does not read, which is exactly what it was before there was a
            // graph at all. Nothing is written before the file exists — with a
            // graph that is the frame or two it takes to configure, and the
            // recording's zero is the first picture that *was* written.
            if (!out.opened) continue;
            const double t = stamp(d.pkt->stream_index, d.frame);

            if (isVideo) {
                if (out.first().vids.empty()) continue;
                const Rgba* pic = toCanvas(d, d.frame, canvas, s.outputs[0].width,
                                           s.outputs[0].height);
                if (!pic) continue;
                if (!out.direct(t, *pic)) break;
            } else if (out.first().mixDest) {
                const int have = d.frame->nb_samples;
                if (have <= 0) continue;
                const int outCount = static_cast<int>(
                    av_rescale_rnd(swr_get_delay(d.swr, d.adec->sample_rate) + have,
                                   rate, d.adec->sample_rate, AV_ROUND_UP));
                // Slack past the samples asked for — see kSwrSlack in
                // export_frame.h. `assign` on a fresh vector allocates exactly
                // what it was told, so this one had no slack at all on its
                // first call: of the four resamplers in this binary it was the
                // one with nothing behind it to absorb the overrun.
                samples.assign(static_cast<size_t>(outCount) * channels + kSwrSlack, 0.0f);
                uint8_t* dst = reinterpret_cast<uint8_t*>(samples.data());
                // `extended_data` rather than `data` for the reason
                // `Writer::drainFifo` uses it: a planar format has one pointer
                // per channel and `AVFrame::data` is eight of them, so a device
                // handing back more than 7.1 planar would be read past the end
                // of the array.
                const int got = swr_convert(
                    d.swr, &dst, outCount,
                    const_cast<const uint8_t**>(d.frame->extended_data), have);
                if (got <= 0) continue;
                if (!out.directSound(t, samples.data(), got)) break;
            }
        }

        st.elapsedSec = secondsSince();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        if (out.opened) {
            st.bytesWritten = out.bytesSoFar();
            st.piecesWritten = out.piecesWritten();
        }
        // **No progress fraction.** There is no total to divide by, and a bar
        // creeping towards an end nobody chose is worse than no bar: what a
        // recording can say honestly is how long it has been going and how big
        // it has got, and both of those are facts.
        if (out.limit > 0.0) {
            st.framesTotal = std::max<int64_t>(1, std::llround(out.limit * s.outputs[0].fps));
            st.progress = std::min(1.0, double(st.framesDone) / double(st.framesTotal));
        }
        job::publish(st);
    }

    // Whatever the filters were still holding. A recording stopped by hand keeps
    // it; one that reached its `-t` does not, because `place` refuses past the
    // limit and that refusal ends the drain.
    if (graph && out.opened && st.state == ExportStatus::State::Running) {
        graph->endAll();
        graph->drain(emit, &err);
    }
    // A graph builds from the first frame, so a device that never handed one
    // over leaves nothing opened and nothing written. Said rather than reported
    // as a clean recording of nothing.
    if (!out.opened && st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Failed;
        st.error = "the device produced nothing for the filter graph to run on";
    }

    const bool failed = st.state == ExportStatus::State::Failed;
    if (out.opened) {
        if (!failed) { st.stage = "finishing"; job::publish(st); }

        // The trailer goes down whatever happened, exactly as it does for a
        // stopped render — and it matters more here. A render that lost its
        // index has lost a file that can be made again; a recording that lost
        // its index has lost the only copy of something that happened once.
        std::string finishErr;
        if (!out.finish(&finishErr)) {
            if (failed) {
                LOG_WARN("capture: %s (while finishing a failed recording)",
                         finishErr.c_str());
                reportNote(AV_LOG_WARNING, "capture",
                           finishErr + " (while finishing a failed recording)");
            } else {
                st.state = ExportStatus::State::Failed;
                st.error = finishErr;
            }
        }
        st.bytesWritten = out.bytesSoFar();
        st.piecesWritten = out.piecesWritten();
    }
}

// ── The session: several devices, on the wall clock ─────────────────────────

/// How many blocks of sound one feed may hold before the job thread has taken
/// them.
///
/// **Sound is a queue and pictures are a slot**, and that difference is the
/// whole of decision six: a picture superseded before the next tick had no tick
/// to appear at, so replacing it loses nothing, while a block of samples
/// dropped or repeated is audible. Bounded all the same, because a job thread
/// that has stalled must not be able to make a reader grow memory for as long
/// as the recording lasts — a hundred and twenty-eight blocks is about two and
/// a half seconds at 1024 samples and 48 kHz, and losing the oldest of them is
/// reported.
constexpr size_t kSoundQueue = 128;

/// What one reader thread hands to the job thread.
///
/// Everything in here is under `m`, and nothing else crosses: the demuxer, the
/// decoders and the scratch frame stay on the reader thread, and what arrives
/// here is an owned reference (`av_frame_ref`) rather than a copy of any
/// pixels.
struct Hand {
    std::mutex m;
    /// The newest picture the job thread has not taken. **Newer replaces
    /// older**: the one that goes is the one that was never going to be shown.
    AVFrame* latest = nullptr;
    bool sawPicture = false;
    /// Sound in the order it arrived, each block with the moment it did.
    std::deque<std::pair<AVFrame*, double>> sound;
    bool warnedSound = false;
    bool ended = false;

    ~Hand() {
        if (latest) av_frame_free(&latest);
        for (auto& b : sound) av_frame_free(&b.first);
    }
};

/// The reader threads and their hand-off state, joined however this leaves.
///
/// **The join is in a destructor** for the reason `job::Slot`'s is: a joinable
/// `std::thread` destroyed is `std::terminate`, which reads as "the last thing
/// it printed crashed" and is nothing of the kind. Every early return in the
/// session below therefore stops and joins its readers without saying so.
struct Readers {
    std::vector<std::unique_ptr<Hand>> hands;
    std::vector<std::thread> threads;
    std::atomic<bool> quit{false};

    void stopAll() {
        quit.store(true);
        for (auto& t : threads) if (t.joinable()) t.join();
        threads.clear();
    }
    ~Readers() { stopAll(); }
};

/// One device, read and decoded, until somebody says stop.
///
/// It does nothing but deposit: the graph, the writer and the clock are the job
/// thread's, so this thread never touches anything another one might. A read
/// that has genuinely hung delays this thread's own join and nothing else,
/// which is the single-device loop's limitation now held per input — the check
/// is between reads, exactly as it always was.
/// `alsoStop` is the *other* reason to give up, and it is a parameter because
/// there are two callers with different ones. A recording's readers stop when
/// the job slot is stopping; a live session's have no job — the whole point of
/// one is to be running while no job is — and would otherwise be torn down by
/// somebody else's recording ending.
void readDevice(Device& d, Hand& h, const std::atomic<bool>& quit,
                const std::function<double()>& secondsSince,
                const std::function<bool()>& alsoStop) {
    while (!quit.load(std::memory_order_relaxed) && !(alsoStop && alsoStop())) {
        av_packet_unref(d.pkt);
        const int rc = av_read_frame(d.fmt, d.pkt);
        if (rc == AVERROR(EAGAIN)) continue;
        if (rc < 0) {
            if (rc != AVERROR_EOF) {
                LOG_WARN("capture: %s: %s", d.name().c_str(), avErr(rc).c_str());
                reportNote(AV_LOG_WARNING, "capture",
                           d.name() + " stopped: " + avErr(rc));
            }
            break;
        }

        const bool isVideo = d.pkt->stream_index == d.videoStream && d.vdec;
        const bool isAudio = d.pkt->stream_index == d.audioStream && d.adec;
        if (!isVideo && !isAudio) continue;

        AVCodecContext* dec = isVideo ? d.vdec : d.adec;
        if (avcodec_send_packet(dec, d.pkt) < 0) continue;

        while (avcodec_receive_frame(dec, d.frame) >= 0) {
            AVFrame* owned = av_frame_alloc();
            if (!owned) break;
            if (av_frame_ref(owned, d.frame) < 0) { av_frame_free(&owned); break; }
            const double arrived = secondsSince();

            std::lock_guard<std::mutex> lock(h.m);
            if (isVideo) {
                if (h.latest) av_frame_free(&h.latest);
                h.latest = owned;
                h.sawPicture = true;
            } else {
                if (h.sound.size() >= kSoundQueue) {
                    AVFrame* oldest = h.sound.front().first;
                    av_frame_free(&oldest);
                    h.sound.pop_front();
                    if (!h.warnedSound) {
                        h.warnedSound = true;
                        reportNote(AV_LOG_WARNING, "capture",
                                   d.name() + ": sound is arriving faster than the render can "
                                              "take it, and the oldest of it is being dropped");
                    }
                }
                h.sound.push_back({owned, arrived});
            }
        }
    }
    std::lock_guard<std::mutex> lock(h.m);
    h.ended = true;
}

/// Drop `skip` samples off the front of a decoded block, in place.
///
/// Pointer arithmetic rather than a copy: the frame's buffer reference still
/// owns the whole allocation and offsetting into it is what libavfilter itself
/// does. It is here because **sound arriving before the session's zero is
/// dropped to the sample**, per feed — a whole block of it is twenty
/// milliseconds, which is audible as a lip-sync error.
void dropFront(AVFrame* f, int skip) {
    if (skip <= 0 || skip >= f->nb_samples) return;
    const auto fmt = static_cast<AVSampleFormat>(f->format);
    const int bytes = av_get_bytes_per_sample(fmt);
    if (bytes <= 0) return;
    const int channels = f->ch_layout.nb_channels > 0 ? f->ch_layout.nb_channels : 1;
    if (av_sample_fmt_is_planar(fmt)) {
        for (int p = 0; p < channels; ++p) {
            if (f->extended_data && f->extended_data[p]) f->extended_data[p] += skip * bytes;
            if (p < AV_NUM_DATA_POINTERS && f->data[p] && f->extended_data != f->data)
                f->data[p] += skip * bytes;
        }
    } else if (f->extended_data && f->extended_data[0]) {
        f->extended_data[0] += static_cast<size_t>(skip) * bytes * channels;
        if (f->extended_data != f->data && f->data[0])
            f->data[0] += static_cast<size_t>(skip) * bytes * channels;
    }
    // `linesize[0]` is the size of a plane, so it moves with the pointers. Left
    // behind it describes a buffer that is longer than what is now in front of
    // the pointer, which is the shape of an overrun waiting for whichever
    // filter reads it rather than `nb_samples`.
    f->linesize[0] -= av_sample_fmt_is_planar(fmt) ? skip * bytes : skip * bytes * channels;
    f->nb_samples -= skip;
}

/// Several live inputs, composited by the graph, written as one file.
///
/// **The session runs on the wall clock, and that is the one thing this loop
/// does that the single-device one does not.** With several inputs no input's
/// clock can be the master: driving off one device's frames means the others
/// are read only when it produces, so a camera that goes quiet stops the screen
/// grab beside it. So there is a tick per output frame at the settled rate, and
/// each video feed is *sampled* at the tick — the newest picture its reader has
/// put down, or the one before it again where nothing arrived. Every feed
/// therefore reaches the graph constant rate and aligned, `overlay`'s framesync
/// has nothing to wait for, and a stall freezes one picture rather than the
/// session. That is the "a stall holds the last picture" rule the writer end
/// already had, moved in front of the graph, which is where N inputs need it.
///
/// Sound is not sampled — see `CaptureGraph::setSession` and decision six.
void runSession(CaptureSettings& s, const std::vector<char>& sizeAsked, ExportStatus& st,
                const DeviceList& devs,
                const std::function<double()>& secondsSince,
                const std::function<void(const std::string&)>& refuse) {
    std::string err;

    // The tick rate. Read before the graph can change `s.output.fps` — a graph
    // ending in `fps=10` decimates what it is *given*, and what it is given is
    // the rate the devices are being sampled at.
    const double tickRate = s.output.fps > 0.0 ? s.output.fps : 30.0;
    const AVRational tickHz = av_d2q(tickRate, 1000000);
    const AVRational tickTb = av_inv_q(tickHz);

    auto graph = std::make_unique<CaptureGraph>(s.output.filterGraph, s.output.audioSampleRate,
                                                s.output.audioChannels, s.output.scaler);
    graph->setSession(tickHz);
    if (!graph->open(feedsOf(devs), &err)) { refuse(err); return; }

    Files out(st);
    out.limit = limitOf(sourcesOf(s));
    // A picture will arrive if any device has one: `open()` refuses a graph
    // that reads the pictures and produces none, and every stream of every
    // input goes through the graph in a session. A session of microphones has
    // no picture for its sound to be measured against and must not wait for one.
    bool anyPicture = false;
    for (const auto& d : devs) if (d->hasVideo()) anyPicture = true;
    out.build(s.outputs, sizeAsked, graph.get(), anyPicture, false);
    const auto emit = [&out](const CaptureGraph::Taken& tk) { return out.emit(tk); };

    Readers readers;
    for (size_t i = 0; i < devs.size(); ++i) readers.hands.push_back(std::make_unique<Hand>());
    for (size_t i = 0; i < devs.size(); ++i) {
        Device* d = devs[i].get();
        Hand* h = readers.hands[i].get();
        readers.threads.emplace_back([d, h, &readers, &secondsSince] {
            readDevice(*d, *h, readers.quit, secondsSince, [] { return job::stopping(); });
        });
    }

    // **The session's zero is the first tick at which every video feed has
    // offered a picture.** It is the generalisation of "the recording's zero is
    // the first picture": a session that started before the second camera had
    // woken up would open with that camera black for however long it took, and
    // the black is not something anybody can get back. A feed that is sound
    // only does not gate it — it has no picture to be waited for.
    //
    // Bounded, because the failure worth refusing is the other one: a session
    // sitting for ever on a device that is never going to answer, with
    // "recording" on the screen and nothing on disk.
    constexpr double kWakeUp = 5.0;
    st.stage = "waiting for the devices";
    job::publish(st);
    for (;;) {
        const Device* missing = nullptr;
        bool dead = false;
        for (size_t i = 0; i < devs.size() && !missing; ++i) {
            if (!devs[i]->hasVideo()) continue;
            std::lock_guard<std::mutex> lock(readers.hands[i]->m);
            if (!readers.hands[i]->sawPicture) {
                missing = devs[i].get();
                dead = readers.hands[i]->ended;
            }
        }
        if (!missing) break;
        if (job::stopping()) {
            refuse("stopped before " + missing->name() +
                   " had produced a picture — nothing was recorded");
            return;
        }
        if (dead || secondsSince() > kWakeUp) {
            refuse(missing->name() + " produced no pictures" +
                   (dead ? " and stopped" : " in the first few seconds") +
                   ", so there is nothing for the graph to composite");
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    const auto zero = Clock::now();
    const double zeroSec = secondsSince();
    st.stage = "recording";
    job::publish(st);

    // The last picture taken off each feed, held so that a feed with nothing
    // new is pushed again at the tick rather than leaving a hole for framesync
    // to wait on. Not cloned: the buffersrc keeps a reference of its own
    // (`AV_BUFFERSRC_FLAG_KEEP_REF`), so re-stamping this one next tick cannot
    // reach what was already queued.
    std::vector<AVFrame*> held(devs.size(), nullptr);

    int64_t tick = 0;
    while (!out.stop) {
        if (job::stopping()) break;
        std::this_thread::sleep_until(
            zero + std::chrono::duration_cast<Clock::duration>(
                       std::chrono::duration<double>(double(tick) / tickRate)));
        if (job::stopping()) break;

        bool anyLive = false;
        for (size_t i = 0; i < devs.size() && !out.stop; ++i) {
            Hand& h = *readers.hands[i];
            const int vFeed = devs[i]->hasVideo() ? graph->feedFor(devs[i]->index, false) : -1;
            const int aFeed = devs[i]->hasAudio() ? graph->feedFor(devs[i]->index, true) : -1;

            AVFrame* fresh = nullptr;
            std::deque<std::pair<AVFrame*, double>> sound;
            {
                std::lock_guard<std::mutex> lock(h.m);
                fresh = h.latest;
                h.latest = nullptr;
                sound.swap(h.sound);
                if (!h.ended) anyLive = true;
            }

            if (fresh) {
                if (held[i]) av_frame_free(&held[i]);
                held[i] = fresh;
            }
            if (vFeed >= 0 && held[i]) {
                held[i]->pts = tick;
                if (!graph->push(vFeed, held[i], tickTb, &err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    out.stop = true;
                }
            }

            for (auto& block : sound) {
                AVFrame* f = block.first;
                const int sr = f->sample_rate > 0 ? f->sample_rate : s.output.audioSampleRate;
                // A block arrived at the moment its *last* sample did, so where
                // it starts is that moment less its own length. Sound from
                // before the session's zero is dropped, to the sample.
                const double start = block.second - zeroSec - double(f->nb_samples) / sr;
                if (aFeed >= 0 && f->nb_samples > 0) {
                    double at = start;
                    if (at < 0.0) {
                        dropFront(f, static_cast<int>(std::llround(-at * sr)));
                        at = 0.0;
                    }
                    if (f->nb_samples > 0) {
                        f->pts = std::llround(at * sr);
                        AVRational tb{1, sr};
                        if (!graph->push(aFeed, f, tb, &err)) {
                            st.state = ExportStatus::State::Failed;
                            st.error = err;
                            out.stop = true;
                        }
                    }
                }
                av_frame_free(&f);
            }
        }

        if (!out.stop && graph->ready() && !out.opened && !out.open(&err)) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            out.stop = true;
        }
        // `emit` refuses when the recording is over, and it has already said
        // which of the two reasons it was.
        if (!out.stop && out.opened && !graph->drain(emit, &err)) out.stop = true;

        st.elapsedSec = secondsSince();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        if (out.opened) {
            st.bytesWritten = out.bytesSoFar();
            st.piecesWritten = out.piecesWritten();
        }
        if (out.limit > 0.0) {
            st.framesTotal = std::max<int64_t>(1, std::llround(out.limit * s.outputs[0].fps));
            st.progress = std::min(1.0, double(st.framesDone) / double(st.framesTotal));
        }
        job::publish(st);

        // Every device has ended. There is nothing further to sample and
        // re-pushing what was held would be recording a still life.
        if (!anyLive) break;
        tick++;
    }

    for (AVFrame*& f : held) if (f) av_frame_free(&f);
    readers.stopAll();

    // Whatever the filters were still holding.
    if (out.opened && st.state == ExportStatus::State::Running) {
        graph->endAll();
        graph->drain(emit, &err);
    }
    if (!out.opened && st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Failed;
        st.error = "the devices produced nothing for the filter graph to run on";
    }

    const bool failed = st.state == ExportStatus::State::Failed;
    if (out.opened) {
        if (!failed) { st.stage = "finishing"; job::publish(st); }
        // The trailer goes down whatever happened. A recording that lost its
        // index has lost the only copy of something that happened once.
        std::string finishErr;
        if (!out.finish(&finishErr)) {
            if (failed) {
                LOG_WARN("capture: %s (while finishing a failed recording)", finishErr.c_str());
                reportNote(AV_LOG_WARNING, "capture",
                           finishErr + " (while finishing a failed recording)");
            } else {
                st.state = ExportStatus::State::Failed;
                st.error = finishErr;
            }
        }
        st.bytesWritten = out.bytesSoFar();
        st.piecesWritten = out.piecesWritten();
    }
}

// ── Watching: the same reading, published instead of written ───────────────
//
// What this shares with the loop above is everything about *getting hold of* a
// frame — `Device`, `openDevice`, `Hand`, `readDevice`, the sample-at-the-tick
// rule and `CaptureGraph` — and that sharing is the point of it being here.
// What it does not share is the loop itself, because the two answer different
// questions. A recording places frames on an output timeline, owes every
// interval a picture, and has `-t` to judge; a preview shows the newest thing
// there is and owes nothing. Merging them would mean a writer that is
// sometimes absent and a limit that is sometimes infinite, threaded through
// every line — which is a worse fact to hold than two short loops with one
// device reader underneath them.

struct LiveRun {
    uint64_t id = 0;
    LiveSettings settings;
    DeviceList devs;
    std::shared_ptr<LiveTap> tap = std::make_shared<LiveTap>();
    std::atomic<bool> quit{false};
    std::thread thread;

    /// Joined here rather than left to the thread, because everything the
    /// thread touches is in this object. Same rule as `Readers`.
    ~LiveRun() {
        quit.store(true);
        if (thread.joinable()) thread.join();
        tap->finishAll();
    }
};

std::mutex liveLock;
std::vector<std::shared_ptr<LiveRun>> liveRuns;
uint64_t liveSeq = 0;

/// One session: read every device, sample at the tick, publish what there is.
void runLive(LiveRun& run) {
    const auto began = Clock::now();
    const auto secondsSince = [&began] {
        return std::chrono::duration<double>(Clock::now() - began).count();
    };

    const double tickRate = run.settings.fps > 0.0 ? run.settings.fps : 30.0;
    const AVRational tickHz = av_d2q(tickRate, 1000000);
    const AVRational tickTb = av_inv_q(tickHz);

    // No graph is the ordinary case: with nothing composited there is nothing
    // to show beyond the devices themselves, and building a pass-through graph
    // to say so would be a filtergraph nobody asked for on every camera.
    std::unique_ptr<CaptureGraph> graph;
    if (!run.settings.filterGraph.empty()) {
        graph = std::make_unique<CaptureGraph>(run.settings.filterGraph,
                                               run.settings.audioSampleRate,
                                               run.settings.audioChannels,
                                               run.settings.scaler);
        graph->setSession(tickHz);
        // The frames go to a decoder, which would only have to undo an RGBA
        // conversion done here. See `CaptureGraph::setConverted`.
        graph->setConverted(false);
        std::string err;
        if (!graph->open(feedsOf(run.devs), &err)) {
            // A graph that will not parse is not a reason to show nothing: the
            // devices are open and their own pads are what a card wants. The
            // Graph stage is already saying the same thing against the node it
            // is about, so this is a line in the log and not a second refusal.
            LOG_WARN("live: %s — showing the devices without it", err.c_str());
            graph.reset();
        }
    }

    Readers readers;
    for (size_t i = 0; i < run.devs.size(); ++i) readers.hands.push_back(std::make_unique<Hand>());
    for (size_t i = 0; i < run.devs.size(); ++i) {
        Device* d = run.devs[i].get();
        Hand* h = readers.hands[i].get();
        readers.threads.emplace_back([d, h, &readers, &secondsSince] {
            readDevice(*d, *h, readers.quit, secondsSince, nullptr);
        });
    }

    std::vector<AVFrame*> held(run.devs.size(), nullptr);
    std::string err;
    int64_t tick = 0;
    while (!run.quit.load(std::memory_order_relaxed)) {
        std::this_thread::sleep_until(
            began + std::chrono::duration_cast<Clock::duration>(
                        std::chrono::duration<double>(double(tick) / tickRate)));
        if (run.quit.load(std::memory_order_relaxed)) break;

        bool anyLive = false;
        for (size_t i = 0; i < run.devs.size(); ++i) {
            Hand& h = *readers.hands[i];
            AVFrame* fresh = nullptr;
            std::deque<std::pair<AVFrame*, double>> sound;
            {
                std::lock_guard<std::mutex> lock(h.m);
                fresh = h.latest;
                h.latest = nullptr;
                sound.swap(h.sound);
                if (!h.ended) anyLive = true;
            }
            if (fresh) {
                if (held[i]) av_frame_free(&held[i]);
                held[i] = fresh;
            }

            // **Published before the graph, and stamped with the tick.** A card
            // shows the device as it arrived; the timestamp is the session's,
            // because an element's clock starts when it starts playing and a
            // camera's own timestamps are whatever its driver felt like.
            const double at = double(tick) / tickRate;
            if (held[i]) {
                if (auto pad = run.tap->pad("in" + std::to_string(i))) pad->put(held[i], at);
                if (graph) {
                    const int vFeed = graph->feedFor(run.devs[i]->index, false);
                    if (vFeed >= 0) {
                        held[i]->pts = tick;
                        if (!graph->push(vFeed, held[i], tickTb, &err))
                            LOG_WARN("live: %s", err.c_str());
                    }
                }
            }

            // Sound reaches the graph — a composition whose sound decides
            // something about its picture is an ordinary graph, and `sidechain`
            // filters exist. **Its level is published here**, on a pad of its
            // own, and that is the meter that matters most: "is the microphone
            // clipping" is a question about the device, before anything the
            // graph does to it, and it has an answer whether or not there is a
            // graph at all. The mix's own level is taken off the sink below.
            //
            // `in<N>:a` is ffmpeg's own way of naming that stream — `0:a` is
            // the sound of input 0 — and it cannot be confused with `in<N>`,
            // which is the picture and is a `<video>` src.
            for (auto& block : sound) {
                AVFrame* f = block.first;
                {
                    auto pad = run.tap->ensure("in" + std::to_string(i) + ":a", true);
                    // The pad measures it — see `LivePadTap::heard`, which is where
                    // the one measurement in this binary lives now that the output
                    // preview publishes a mix into one of these too.
                    pad->heard(f);
                    // **And the block itself, to whoever is monitoring.** The
                    // level is measured whatever happens; the frame is only
                    // referenced when something is listening — see `putSound`.
                    // The device's own sound, before the graph, is what somebody
                    // checking a microphone wants to hear, for the same reason
                    // its level is the one that answers "is it clipping".
                    pad->putSound(f, block.second);
                }
                const int aFeed = graph && run.devs[i]->hasAudio()
                                      ? graph->feedFor(run.devs[i]->index, true) : -1;
                const int sr = f->sample_rate > 0 ? f->sample_rate
                                                  : run.settings.audioSampleRate;
                if (aFeed >= 0 && f->nb_samples > 0 && sr > 0) {
                    f->pts = std::llround(std::max(0.0, block.second) * sr);
                    AVRational tb{1, sr};
                    if (!graph->push(aFeed, f, tb, &err)) LOG_WARN("live: %s", err.c_str());
                }
                av_frame_free(&f);
            }
        }

        if (graph && graph->ready()) {
            graph->drain([&run](const CaptureGraph::Taken& t) {
                if (!t.raw) return true;
                // **Sound is measured here and published as a level.** It used
                // to be dropped on this line, which left a session with a
                // microphone in it saying nothing at all about the microphone —
                // and the levels are the reading somebody wants *before* a take
                // rather than the recording afterwards. Playing the mix is a
                // different thing again and is not this.
                if (t.audio) {
                    const std::string name =
                        t.label.empty() || t.primary ? "aout" : t.label;
                    auto pad = run.tap->ensure(name, false);
                    pad->heard(t.raw);
                    // The mix, for whoever is listening to it. This is the
                    // pad worth hearing rather than measuring: what two
                    // microphones and an `amix` make together is the thing
                    // that only existed in the file afterwards, which is
                    // exactly what the picture side of this stage already
                    // says about `vout`.
                    pad->putSound(t.raw, t.at >= 0.0 ? t.at : 0.0);
                    return true;
                }
                // The composite is the pad nobody had to name, and `vout` is
                // what it is called everywhere else in this application —
                // `resolvePads` maps it, `graph/record.js` writes it. A pad
                // with a name of its own keeps it.
                const std::string name = t.label.empty() || t.primary ? "vout" : t.label;
                run.tap->ensure(name, false)->put(t.raw, t.at);
                return true;
            }, &err);
        }

        if (!anyLive) break;
        tick++;
    }

    for (AVFrame*& f : held) if (f) av_frame_free(&f);
    readers.stopAll();
    run.tap->finishAll();
}

// ── The job ────────────────────────────────────────────────────────────────

/// **Which of the two loops runs is the number of inputs**, and nothing else.
///
/// One device has no second clock to be lined up with, so it keeps the media
/// timestamps it always had — which is what lets a `-f lavfi` input record
/// faster than real time and what every existing recording in this application
/// still means. Several devices have no shared clock at all, so they get one:
/// see `runSession`.
void runCapture(CaptureSettings s, DeviceList devs, std::vector<char> sizeAsked) {
    job::Held slot;

    const auto began = Clock::now();
    const std::function<double()> secondsSince = [&began] {
        return std::chrono::duration<double>(Clock::now() - began).count();
    };

    ExportStatus st = job::status();
    st.state = ExportStatus::State::Running;
    st.path = s.output.path;
    st.stage = "opening";
    job::publish(st);

    // A loop that gives up says so and leaves; the terminal state is still
    // published once, at the bottom, after whatever file there was has been
    // closed — which is the slot's rule and not either loop's.
    const std::function<void(const std::string&)> refuse = [&st](const std::string& why) {
        st.state = ExportStatus::State::Failed;
        st.error = why;
    };

    if (devs.size() == 1) runDirect(s, sizeAsked, st, devs.front(), secondsSince, refuse);
    else runSession(s, sizeAsked, st, devs, secondsSince, refuse);

    // **Stopping a recording is how a recording ends.** It is not a
    // cancellation: nothing was abandoned and nothing was lost, and the length
    // was the open question that pressing stop answered. Reporting Cancelled
    // would make every successful recording look like a mistake, and would make
    // the one thing worth distinguishing — a recording that failed —
    // indistinguishable from the ordinary case.
    if (st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Done;
        st.stage = "done";
        st.progress = 1.0;
    }
    st.elapsedSec = secondsSince();

    job::release();
    job::publish(st);

    // Every file by name, because the second one is the one nobody sees on the
    // stage and the report is where a recording says what it left behind. The
    // frames and the megabytes are the recording's — the count is the primary's
    // clock and the size is the sum of all of them.
    std::string wrote = s.outputs.front().path;
    for (size_t i = 1; i < s.outputs.size(); ++i) wrote += " + " + s.outputs[i].path;

    char said[1024];
    if (st.state == ExportStatus::State::Done) {
        LOG_INFO("capture: wrote %s (%lld frames, %.1f s, %.1f MB)", wrote.c_str(),
                 static_cast<long long>(st.framesDone), st.elapsedSec,
                 st.bytesWritten / 1048576.0);
        std::snprintf(said, sizeof(said), "recorded %s — %lld frames in %.1f s, %.1f MB",
                      wrote.c_str(), static_cast<long long>(st.framesDone),
                      st.elapsedSec, st.bytesWritten / 1048576.0);
        reportNote(AV_LOG_INFO, "capture", said);
    } else {
        LOG_ERROR("capture failed: %s", st.error.c_str());
        reportNote(AV_LOG_ERROR, "capture", st.error);
    }
}

} // namespace

bool startCapture(const CaptureSettings& settings, std::string* error,
                  uint64_t* jobNumber) {
    CaptureSettings s = settings;
    s.sources = sourcesOf(s);
    s.source = s.sources.front();
    // The same rule one field up: an absent list is `{output}`, and given a
    // list the singular field is its first entry. Normalised once, here, so
    // that nothing past this point has to ask which of the two it is reading —
    // and `output` is still what the session-wide answers are taken from,
    // because the graph, the sample rate and the channel count belong to the
    // recording rather than to any file of it.
    if (s.outputs.empty()) s.outputs.push_back(s.output);
    s.output = s.outputs.front();

    for (size_t i = 0; i < s.sources.size(); ++i)
        if (s.sources[i].path.empty()) {
            if (error) *error = s.sources.size() == 1
                ? "no device to record from"
                : "input " + std::to_string(i) + " has no device to record from";
            return false;
        }
    for (size_t i = 0; i < s.outputs.size(); ++i) {
        if (s.outputs[i].path.empty()) {
            if (error) *error = s.outputs.size() == 1
                ? "no output file"
                : "file " + std::to_string(i + 1) + " of " +
                  std::to_string(s.outputs.size()) + " has no path to write to";
            return false;
        }
        // **Two files at one path is one file written twice**, and libavformat
        // will happily open both and interleave them into a container nothing
        // can read. Refused by name rather than by index, because the path is
        // what somebody typed and the index is this list's business.
        for (size_t j = 0; j < i; ++j)
            if (s.outputs[j].path == s.outputs[i].path) {
                if (error)
                    *error = "two of the files this recording writes are both " +
                             s.outputs[i].path + " — one muxer per file, and two "
                             "writing to one would interleave into something no player reads";
                return false;
            }
        // **A recording's frame timing is the wall clock, so `vfr` is refused by
        // name.** The devices decide when a picture exists and `place()` fills
        // the output's grid in from that, which is constant by construction —
        // there is no second set of frame times for this to keep, and a
        // recording that accepted the setting and ignored it would be the shrug
        // an unknown option is refused for everywhere else here.
        // Anything but `cfr` rather than `vfr` alone, so a word nobody here has
        // heard of is refused too and not read as the default.
        if (!s.outputs[i].fpsMode.empty() && s.outputs[i].fpsMode != "cfr") {
            if (error)
                *error = "a recording is timed by the wall clock, so its frames have no times "
                         "of their own for '" + s.outputs[i].fpsMode + "' to keep — a variable "
                         "frame rate is something a filter graph in a render has and a device "
                         "does not";
            return false;
        }
        // **The sound format is the session's, on every file.** What reaches a
        // writer is interleaved float at one rate and one channel count — it is
        // what came off the graph — and a file that believed otherwise would
        // resample from a rate the samples are not at. A file that wants
        // another rate says so on its *encoder*, which is where `-ar` goes.
        s.outputs[i].audioSampleRate = s.output.audioSampleRate;
        s.outputs[i].audioChannels = s.output.audioChannels;
        s.outputs[i].includeAudio = s.output.includeAudio;
    }
    // **A capture's graph is fed by its devices and by nothing else *through
    // its input pads*.** A `filterInputs` list says which file feeds which
    // `[n:v]`, which is the render's question and the render's mechanism: there
    // a `GraphSource` opens the file and pulls it backwards from a sink. Here
    // those pads are buffersrcs the recording loop pushes device frames into,
    // nothing pushes a file, and pulling is exactly what a device cannot be
    // asked for.
    //
    // **That is not the same as "no file in a capture's graph"**, and the
    // refusal says so, because the difference is a whole capability and used to
    // be written down as a missing one. A `movie` node has no input pad of ours
    // at all — libavfilter opens the file itself and framesync asks it for the
    // frame that pairs with the one the device just delivered, which is one per
    // output frame and no more. Measured in tests/capture_test.cpp.
    if (!s.output.filterInputs.empty()) {
        if (error)
            *error = "a recording's filter graph is fed by the device — [0:v] and [0:a] — "
                     "and cannot be given input files of its own; a movie filter in the "
                     "graph text reads a file and is pulled in step with the device";
        return false;
    }
    // **Several inputs with no graph have no defined composition.** Two
    // pictures and nothing saying how they go together is not something this or
    // anything else could guess at, and guessing — picking the first, stacking
    // them in the order they were given — would be a recording that succeeded
    // while ignoring one of the devices it was told to read.
    if (s.sources.size() > 1 && s.output.filterGraph.empty()) {
        if (error)
            *error = "this recording has " + std::to_string(s.sources.size()) +
                     " inputs and no filter graph — the graph is what says how they combine, "
                     "so [0:v] and [1:v] have nowhere to meet";
        return false;
    }

    const uint64_t number = job::claim(s.output.path, error);
    if (!number) return false;
    if (jobNumber) *jobNumber = number;

    // **A recording opens its own devices, so anything watching gives them
    // back first.** The Capture stage already tears its session down before
    // asking for a recording; this is here so the rule holds whoever asked,
    // because a DirectShow camera held by a preview is not a slow recording,
    // it is one that fails at the open with nothing on screen to explain it.
    // Enforced rather than assumed, for the reason the previews were torn down
    // before the session existed.
    closeAllLive();

    // Opened before the thread exists, so "there is no camera called that"
    // arrives as a refusal from this call rather than as a job that starts and
    // fails a moment later with the name that was wrong already off the screen.
    // **Every one of them**, and on this thread rather than on the reader thread
    // that goes on to read it, or the second of two devices would fail out of
    // sight with nothing saying which one it was.
    DeviceList devs;
    std::string why;
    bool ok = true;
    for (size_t i = 0; i < s.sources.size() && ok; ++i) {
        auto dev = std::make_shared<Device>();
        ok = openDevice(*dev, s.sources[i], static_cast<int>(i), s, &why);
        devs.push_back(std::move(dev));
    }
    // **What each file asked for, before the blanks were filled in.** It has to
    // be taken here because this is the last moment the two are distinguishable,
    // and they have to be: a file that named no size gets the graph's composite
    // pad once the graph has configured, and a file that named one is a proxy,
    // which exists to be another size. Carried to the job thread beside the
    // settings rather than written into them — `ExportSettings` is the render's
    // struct too, and "did somebody say?" is this list's question, not a render's.
    std::vector<char> sizeAsked;
    for (const auto& out : s.outputs)
        sizeAsked.push_back(out.width > 0 && out.height > 0 ? 1 : 0);
    if (ok) {
        for (auto& out : s.outputs) settleOutput(out, devs);
        s.output = s.outputs.front();
    }

    // And the graph is parsed here for the same reason, on a throwaway object:
    // a filter this build has not got, a pad the devices cannot feed and a chain
    // that wants a graphics card are all things the person who typed the graph
    // should be told about while it is still on the screen. What *runs* is built
    // on the job thread, because that is where the writer is built too — this
    // one is parsed, read and dropped.
    if (ok && !s.output.filterGraph.empty()) {
        CaptureGraph probe(s.output.filterGraph, s.output.audioSampleRate,
                           s.output.audioChannels, s.output.scaler);
        ok = probe.open(feedsOf(devs), &why);
        // **With several inputs every stream has to go through the graph.** The
        // bypass — a stream the graph does not read going straight to the writer
        // — is one device's picture staying the composite, and with two devices
        // there is no answer to which of them that would be. Said here, naming
        // the pad, rather than by silently picking one.
        for (size_t i = 0; ok && s.sources.size() > 1 && i < devs.size(); ++i) {
            for (const bool audio : {false, true}) {
                if (audio ? !devs[i]->hasAudio() : !devs[i]->hasVideo()) continue;
                if (probe.feedFor(static_cast<int>(i), audio) >= 0) continue;
                why = "[" + std::to_string(i) + (audio ? ":a" : ":v") +
                      "] is not read by the graph, and with several inputs there is no "
                      "answer to which of them the file would be of — every stream has to "
                      "go through the graph, because the graph is what says how they combine";
                ok = false;
                break;
            }
        }
    }
    if (!ok) {
        // **The claim is given back the way the job thread gives it back.**
        // `job::claim()` numbers the render in the report channel as well as
        // taking the slot, and `job::Held` is what closes that number again —
        // but it lives inside the job body, which this path never reaches.
        // Freeing the slot on its own left the channel's job number set for the
        // rest of the process, so every `av_log` line said afterwards by
        // anything at all — a probe, a decoder during playback, the next render
        // — was attributed to a recording that never happened. Declared first
        // so it runs last, which is the same rule the job body follows.
        job::Held slot;
        job::release();
        ExportStatus st = job::status();
        st.state = ExportStatus::State::Failed;
        st.error = why;
        st.stage = "failed";
        job::publish(st);
        if (error) *error = why;
        return false;
    }

    {
        // **`framesTotal` stays zero when nobody knows.** The same rule
        // `inputDuration` follows: zero means unknown, not "no frames". With a
        // `-t` on a device there *is* an end, and then it is a real total and
        // the percentage means something. A graph that changes the rate makes
        // this an estimate until the graph is configured, which is where it is
        // said again.
        const double limit = limitOf(s.sources);
        ExportStatus st = job::status();
        st.openEnded = limit <= 0.0;
        st.framesTotal = st.openEnded
            ? 0 : std::max<int64_t>(1, std::llround(limit * s.output.fps));
        st.stage = "starting";
        job::publish(st);
    }

    job::run([s, devs, sizeAsked] { runCapture(s, devs, sizeAsked); });
    return true;
}

void stopCapture() { job::stop(); }

// ── Sessions ───────────────────────────────────────────────────────────────

uint64_t openLive(const LiveSettings& settings, std::string* error) {
    if (settings.sources.empty()) {
        if (error) *error = "no device to watch";
        return 0;
    }

    // `openDevice` asks a `CaptureSettings` what sound it wants, because that
    // is the question it has always been asked. Built here rather than
    // widening its signature: a session and a recording want a device opened
    // in exactly the same way, and that is worth keeping obvious.
    CaptureSettings as;
    as.output.includeAudio = settings.includeAudio;
    as.output.audioSampleRate = settings.audioSampleRate;
    as.output.audioChannels = settings.audioChannels;
    as.output.scaler = settings.scaler;

    auto run = std::make_shared<LiveRun>();
    run->settings = settings;
    for (size_t i = 0; i < settings.sources.size(); ++i) {
        auto d = std::make_shared<Device>();
        std::string why;
        // **On this thread**, for the reason a recording opens its devices on
        // the caller's: "there is no camera called that" belongs to the call
        // that asked, while the name that was wrong is still on screen.
        if (!openDevice(*d, settings.sources[i], static_cast<int>(i), as, &why)) {
            if (error) *error = why;
            return 0;
        }
        run->devs.push_back(std::move(d));
    }

    // **The device pads exist before the thread does.** A caller asks what a
    // session publishes the instant `openLive` returns, and "one per input
    // that has a picture" is knowable from the devices that were just opened —
    // so making them on the session thread would be a race the caller could
    // only lose by being quick. The *graph's* pads cannot be settled here: their
    // names are the graph's and their sizes are not known until libavfilter has
    // configured it, which needs a frame.
    for (size_t i = 0; i < run->devs.size(); ++i)
        if (run->devs[i]->hasVideo()) run->tap->ensure("in" + std::to_string(i), true);

    {
        std::lock_guard<std::mutex> lock(liveLock);
        run->id = ++liveSeq;
        liveRuns.push_back(run);
    }
    LiveRun* raw = run.get();
    run->thread = std::thread([raw] { runLive(*raw); });
    LOG_INFO("live: session %llu watching %zu device%s",
             static_cast<unsigned long long>(run->id), run->devs.size(),
             run->devs.size() == 1 ? "" : "s");
    return run->id;
}

std::vector<LivePad> livePads(uint64_t id) {
    std::shared_ptr<LiveRun> run;
    {
        std::lock_guard<std::mutex> lock(liveLock);
        for (const auto& r : liveRuns) if (r->id == id) { run = r; break; }
    }
    std::vector<LivePad> out;
    if (!run) return out;
    for (const auto& p : run->tap->all()) {
        LivePad pad;
        pad.name = p->name();
        pad.device = p->isDevice();
        p->size(&pad.width, &pad.height);
        // What it carries, but **not** what it is doing: reading a level clears
        // it, and this call is made several times a frame by whatever is
        // looking for a pad by name. See `liveLevels`.
        pad.sound = p->isSound();
        out.push_back(std::move(pad));
    }
    return out;
}

std::vector<LiveLevel> liveLevels(uint64_t id) {
    std::shared_ptr<LiveRun> run;
    {
        std::lock_guard<std::mutex> lock(liveLock);
        for (const auto& r : liveRuns) if (r->id == id) { run = r; break; }
    }
    std::vector<LiveLevel> out;
    if (!run) return out;
    for (const auto& p : run->tap->all()) {
        if (!p->isSound()) continue;
        LiveLevel l;
        l.name = p->name();
        l.heard = p->level(&l.channels);
        out.push_back(std::move(l));
    }
    return out;
}

void closeLive(uint64_t id) {
    std::shared_ptr<LiveRun> run;
    {
        std::lock_guard<std::mutex> lock(liveLock);
        for (auto it = liveRuns.begin(); it != liveRuns.end(); ++it)
            if ((*it)->id == id) { run = *it; liveRuns.erase(it); break; }
    }
    // Dropped outside the lock: the destructor joins the session thread, and
    // that thread's last act is to touch the tap. Holding `liveLock` across it
    // would be holding a lock across a join for no reason.
    if (run) LOG_INFO("live: session %llu closed", static_cast<unsigned long long>(id));
}

void closeAllLive() {
    std::vector<std::shared_ptr<LiveRun>> going;
    {
        std::lock_guard<std::mutex> lock(liveLock);
        going.swap(liveRuns);
    }
}

std::shared_ptr<LiveTap> liveTapFor(uint64_t id) {
    std::lock_guard<std::mutex> lock(liveLock);
    for (const auto& r : liveRuns) if (r->id == id) return r->tap;
    return nullptr;
}

} // namespace ffmpegbro
