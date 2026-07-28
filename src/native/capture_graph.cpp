// Pushing a device through libavfilter. See capture_graph.h for why this is a
// second graph class rather than a mode of the first.

#include "capture_graph.h"

#include "export_graph.h"
#include "ffmpeg_report.h"

#include "util/log.h"

extern "C" {
#include <libavutil/opt.h>
}

#include <algorithm>
#include <cstdlib>
#include <cstring>

namespace ffmpegbro {
namespace {

/// How many frames one feed may hold while the other is still settling.
///
/// The queue exists because two feeds of one device do not produce their first
/// frame at the same instant, and what arrives in between is the beginning of
/// the recording rather than something to throw away. It is bounded because a
/// device that hands over pictures and never a single block of sound would
/// otherwise grow it for the length of the recording — which for this job is
/// however long somebody leaves it running.
constexpr size_t kPendingCap = 240;

AVMediaType typeOfInput(const AVFilterInOut* io) {
    return avfilter_pad_get_type(io->filter_ctx->input_pads, io->pad_idx);
}

AVMediaType typeOfOutput(const AVFilterInOut* io) {
    return avfilter_pad_get_type(io->filter_ctx->output_pads, io->pad_idx);
}

const char* nameOf(const AVFilterInOut* io) { return io->name ? io->name : ""; }

/// When a frame leaving a sink says it happened, in seconds on the sink's own
/// clock. The same reading `GraphSource` takes, and for the same reason: what a
/// measuring filter attached to this frame is a fact about *this* frame.
double frameTime(const AVFilterContext* sink, const AVFrame* f) {
    if (!f || f->pts == AV_NOPTS_VALUE) return -1.0;
    const AVRational tb = av_buffersink_get_time_base(sink);
    return tb.den > 0 ? f->pts * av_q2d(tb) : -1.0;
}

/// `0:v` split into the input it names and the stream of it.
///
/// A recording's input pads are ffmpeg's own `[<n>:v]`/`[<n>:a]` and nothing
/// else: there is no clip list here to derive a second vocabulary from, and a
/// label this cannot read is a label nothing can feed.
bool readLabel(const std::string& label, int* input, bool* audio) {
    const size_t colon = label.find(':');
    if (colon == std::string::npos || colon == 0 || colon + 2 != label.size()) return false;
    for (size_t i = 0; i < colon; ++i)
        if (label[i] < '0' || label[i] > '9') return false;
    const char kind = label[colon + 1];
    if (kind != 'v' && kind != 'a') return false;
    *input = std::atoi(label.substr(0, colon).c_str());
    *audio = kind == 'a';
    return true;
}

} // namespace

CaptureGraph::CaptureGraph(std::string text, int sampleRate, int channels, std::string scaler)
    : text_(std::move(text)), sampleRate_(std::max(1, sampleRate)),
      channels_(std::max(1, channels)), scaler_(std::move(scaler)) {}

CaptureGraph::Feed::~Feed() {
    for (AVFrame* f : pending) av_frame_free(&f);
}

CaptureGraph::Sink::~Sink() {
    if (frame) av_frame_free(&frame);
    if (toRgba) sws_freeContext(toRgba);
    if (swr) swr_free(&swr);
}

CaptureGraph::~CaptureGraph() {
    // Before the graph, because each of them holds a filter context the graph
    // owns and reading the teardown the other way round invites somebody to
    // touch one after it has gone.
    feeds_.clear();
    sinks_.clear();
    vprimary_ = aprimary_ = nullptr;
    if (graph_) avfilter_graph_free(&graph_);
}

// ── Opening ────────────────────────────────────────────────────────────────

bool CaptureGraph::open(const std::vector<FeedSource>& inputs, std::string* err) {
    const auto fail = [err](const std::string& why) {
        if (err) *err = why;
        return false;
    };

    graph_ = avfilter_graph_alloc();
    if (!graph_) return fail("out of memory building the graph");

    AVFilterInOut* ins = nullptr;
    AVFilterInOut* outs = nullptr;
    std::string wantsDevice;
    const int rc = parseFilterGraph(graph_, text_, nullptr, &ins, &outs, &wantsDevice);
    if (rc < 0) {
        avfilter_inout_free(&ins);
        avfilter_inout_free(&outs);
        if (!wantsDevice.empty())
            return fail(wantsDevice + " runs on a graphics card, and a recording has nowhere "
                                      "to say which one — filter the file afterwards, or take "
                                      "the card out of this graph");
        return fail("the filter graph will not parse: " + avErr(rc));
    }

    bool ok = true;
    for (AVFilterInOut* in = ins; in && ok; in = in->next) {
        const std::string label = nameOf(in);
        int index = 0;
        bool audio = false;
        if (!readLabel(label, &index, &audio)) {
            ok = fail("the graph reads [" + (label.empty() ? std::string("an unlabelled pad")
                                                           : label) +
                      "] and there is nothing here to feed it — a recording's input pads are "
                      "[0:v] and [0:a], the device's own streams");
            break;
        }
        const FeedSource* src = nullptr;
        for (const auto& f : inputs) if (f.index == index) { src = &f; break; }
        if (!src) {
            // **The index is named**, because with a list of inputs that is the
            // whole of what is wrong: [1:v] against one device is a graph
            // written for a session that has not been given its second source,
            // and "this recording has one input" leaves the reader to work out
            // which of the labels they wrote was the offending one.
            ok = fail("the graph reads [" + label + "] and this recording has no input " +
                      std::to_string(index) + " — it has " + std::to_string(inputs.size()) +
                      (inputs.size() == 1 ? " input, which is [0:v] and [0:a]"
                                          : " inputs, numbered from [0:…] upwards in the order "
                                            "they were given"));
            break;
        }
        if (audio ? !src->hasAudio : !src->hasVideo) {
            ok = fail("the graph reads [" + label + "] and input " + std::to_string(index) +
                      " produces no " + (audio ? "sound" : "pictures"));
            break;
        }
        if (audio != (typeOfInput(in) == AVMEDIA_TYPE_AUDIO)) {
            ok = fail("[" + label + "] is " + (audio ? "sound" : "a picture") +
                      " and the filter it reaches wants the other");
            break;
        }
        for (const auto& f : feeds_)
            if (f->label == label)
                ok = fail("[" + label + "] is read twice and one input pad holds one wire");
        if (!ok) break;

        auto feed = std::make_unique<Feed>();
        feed->input = index;
        feed->audio = audio;
        feed->label = label;
        feed->into = in->filter_ctx;
        feed->intoPad = in->pad_idx;
        feeds_.push_back(std::move(feed));
    }

    for (AVFilterInOut* out = outs; out && ok; out = out->next) {
        auto sink = std::make_unique<Sink>();
        sink->audio = typeOfOutput(out) == AVMEDIA_TYPE_AUDIO;
        sink->label = nameOf(out);
        sink->frame = av_frame_alloc();
        if (!sink->frame) { ok = fail("out of memory"); break; }
        const std::string name = std::string("out_") + (sink->audio ? "a" : "v") +
                                 std::to_string(sinks_.size());
        int lrc = avfilter_graph_create_filter(
            &sink->ctx, avfilter_get_by_name(sink->audio ? "abuffersink" : "buffersink"),
            name.c_str(), nullptr, nullptr, graph_);
        if (lrc >= 0) lrc = avfilter_link(out->filter_ctx, out->pad_idx, sink->ctx, 0);
        if (lrc < 0) {
            ok = fail(std::string("cannot take the ") + (sink->audio ? "sound" : "picture") +
                      " out of the graph: " + avErr(lrc));
            break;
        }
        sinks_.push_back(std::move(sink));
    }

    avfilter_inout_free(&ins);
    avfilter_inout_free(&outs);
    if (!ok) return false;

    // What the graph does not read still gets recorded: a graph that only
    // touches the sound leaves the picture exactly as it was, which is the
    // ordinary "record my screen and normalise the microphone" case and is why
    // this is a fact about the feeds rather than a setting.
    bool readsVideo = false, readsAudio = false;
    for (const auto& f : feeds_) (f->audio ? readsAudio : readsVideo) = true;
    bool anyVideo = false, anyAudio = false;
    for (const auto& s : inputs) {
        if (s.hasVideo) anyVideo = true;
        if (s.hasAudio) anyAudio = true;
    }
    videoDirect_ = anyVideo && !readsVideo;
    audioDirect_ = anyAudio && !readsAudio;

    choosePrimaries();
    // Where the device keeps its own picture, *that* is the composite and a
    // video pad of the graph is only reachable by name. Two answers to "which
    // picture is the canvas" is a file with one of them silently in it.
    if (videoDirect_) { if (vprimary_) vprimary_->mapped = false; vprimary_ = nullptr; }
    if (audioDirect_) { if (aprimary_) aprimary_->mapped = false; aprimary_ = nullptr; }

    if (readsVideo && !videoDirect_) {
        bool anyPicture = false;
        for (const auto& s : sinks_) if (!s->audio) anyPicture = true;
        if (!anyPicture)
            return fail("this graph reads the device's picture and produces none, so there "
                        "would be nothing to record");
    }
    return true;
}

void CaptureGraph::choosePrimaries() {
    for (const bool audio : {false, true}) {
        Sink*& slot = audio ? aprimary_ : vprimary_;
        Sink* only = nullptr;
        Sink* named = nullptr;
        int count = 0;
        for (auto& s : sinks_) {
            if (s->audio != audio) continue;
            ++count;
            only = s.get();
            if (s->label == (audio ? "aout" : "vout")) named = s.get();
        }
        slot = count == 1 ? only : named;
        if (slot) slot->mapped = true;
    }
}

int CaptureGraph::feedFor(int input, bool audio) const {
    for (size_t i = 0; i < feeds_.size(); ++i)
        if (feeds_[i]->input == input && feeds_[i]->audio == audio) return static_cast<int>(i);
    return -1;
}

// ── Building, once the formats are known ───────────────────────────────────

bool CaptureGraph::describeFeed(Feed& f, const AVFrame* frame, AVRational timeBase,
                                std::string* err) {
    AVBufferSrcParameters* par = av_buffersrc_parameters_alloc();
    if (!par) { if (err) *err = "out of memory"; return false; }

    const std::string name = (f.audio ? "in_a" : "in_v") + std::to_string(feeds_.size()) + "_" +
                             std::to_string(f.input);
    f.src = avfilter_graph_alloc_filter(graph_,
                                        avfilter_get_by_name(f.audio ? "abuffer" : "buffer"),
                                        name.c_str());
    if (!f.src) {
        av_free(par);
        if (err) *err = "this build has no buffer source to feed the graph from";
        return false;
    }

    // The time base is the device stream's and the timestamps are left alone.
    // What the graph is handed is the device's own clock; moving its zero is
    // done at the other end, on what comes *out*, because a filter that changes
    // the rate makes the two different clocks.
    par->time_base = timeBase;
    if (!f.audio) {
        // A session samples every video feed at its own tick, so it is the one
        // caller that genuinely knows the rate a buffersrc is being fed at.
        // Telling the graph makes `overlay`'s framesync a lookup rather than a
        // guess, and leaves `fps` a filter that decimates a known rate instead
        // of one inferring one from the timestamps as they go by.
        if (session_.num > 0) par->frame_rate = session_;
        par->format = frame->format;
        par->width = frame->width;
        par->height = frame->height;
        par->sample_aspect_ratio = frame->sample_aspect_ratio.num ? frame->sample_aspect_ratio
                                                                  : AVRational{1, 1};
        par->color_space = frame->colorspace;
        par->color_range = frame->color_range;
    } else {
        par->format = frame->format;
        par->sample_rate = frame->sample_rate;
        av_channel_layout_copy(&par->ch_layout, &frame->ch_layout);
    }

    int rc = av_buffersrc_parameters_set(f.src, par);
    av_channel_layout_uninit(&par->ch_layout);
    av_free(par);
    if (rc >= 0) rc = avfilter_init_dict(f.src, nullptr);

    // Drift compensation, in front of the graph and not inside it.
    //
    // Two devices are two crystal oscillators: a microphone's 48000 samples a
    // second and a camera's are the same number of a slightly different second,
    // and over a few minutes that is a soundtrack visibly out of step with a
    // picture placed on the wall clock. `aresample=async` is ffmpeg's own answer
    // — it stretches or squeezes by a few samples at a time to follow the
    // timestamps, which is inaudible where dropping or repeating a whole block
    // would not be. `first_pts=0` makes the session's zero the stream's zero
    // rather than whenever this feed's first block happened to arrive.
    //
    // Inserted where `GraphSource` inserts `transpose`: between the buffersrc
    // and the pad the graph text named, so what was written is still what runs.
    AVFilterContext* tail = f.src;
    if (rc >= 0 && f.audio && session_.num > 0) {
        const AVFilter* async = avfilter_get_by_name("aresample");
        if (!async) {
            if (err) *err = "this build has no aresample, and live sound from several devices "
                            "cannot be kept in step without one";
            return false;
        }
        AVFilterContext* smooth = nullptr;
        const std::string name = "async_" + std::to_string(f.input);
        rc = avfilter_graph_create_filter(&smooth, async, name.c_str(),
                                          "async=1000:first_pts=0", nullptr, graph_);
        if (rc >= 0) rc = avfilter_link(f.src, 0, smooth, 0);
        if (rc >= 0) tail = smooth;
    }

    if (rc >= 0) rc = avfilter_link(tail, 0, f.into, f.intoPad);
    if (rc < 0) {
        if (err) *err = "cannot connect [" + f.label + "] to the graph: " + avErr(rc);
        return false;
    }
    f.described = true;
    return true;
}

bool CaptureGraph::configure(std::string* err) {
    const int rc = avfilter_graph_config(graph_, nullptr);
    if (rc < 0) {
        if (err) *err = "the filter graph will not run: " + avErr(rc);
        return false;
    }
    configured_ = true;
    return true;
}

bool CaptureGraph::push(int feed, const AVFrame* frame, AVRational timeBase, std::string* err) {
    if (feed < 0 || static_cast<size_t>(feed) >= feeds_.size()) return true;
    Feed& f = *feeds_[static_cast<size_t>(feed)];
    if (f.closed) return true;

    if (configured_) {
        av_buffersrc_add_frame_flags(f.src, const_cast<AVFrame*>(frame),
                                     AV_BUFFERSRC_FLAG_KEEP_REF);
        return true;
    }

    if (!f.described && !describeFeed(f, frame, timeBase, err)) return false;

    AVFrame* copy = av_frame_clone(frame);
    if (!copy) { if (err) *err = "out of memory"; return false; }
    if (f.pending.size() >= kPendingCap) {
        // The oldest goes, so what is kept is the run of frames nearest to the
        // moment the graph actually starts. Said once: a device that never
        // produces its other stream is worth a line, and one line per frame
        // would be the recording's log.
        AVFrame* oldest = f.pending.front();
        av_frame_free(&oldest);
        f.pending.erase(f.pending.begin());
        if (!f.warnedFull) {
            f.warnedFull = true;
            reportNote(AV_LOG_WARNING, "capture",
                       "[" + f.label + "] is waiting for the device's other stream and is "
                       "dropping what it cannot hold");
        }
    }
    f.pending.push_back(copy);

    for (const auto& other : feeds_) if (!other->described) return true;
    if (!configure(err)) return false;

    // Everything that arrived while the formats were being settled, in the
    // order it arrived. `av_buffersrc_add_frame` unreferences what it is given,
    // so the frames themselves are still ours to free.
    for (auto& p : feeds_) {
        for (AVFrame* q : p->pending) {
            av_buffersrc_add_frame(p->src, q);
            av_frame_free(&q);
        }
        p->pending.clear();
    }
    return true;
}

void CaptureGraph::endFeed(int feed) {
    if (feed < 0 || static_cast<size_t>(feed) >= feeds_.size()) return;
    Feed& f = *feeds_[static_cast<size_t>(feed)];
    if (f.closed) return;
    f.closed = true;
    if (configured_ && f.src) av_buffersrc_add_frame(f.src, nullptr);
}

void CaptureGraph::endAll() {
    for (size_t i = 0; i < feeds_.size(); ++i) endFeed(static_cast<int>(i));
}

// ── Draining ───────────────────────────────────────────────────────────────

const CaptureGraph::Sink* CaptureGraph::sinkFor(const std::string& label) const {
    if (label.empty()) return nullptr;
    for (const auto& s : sinks_) if (s->label == label) return s.get();
    return nullptr;
}

CaptureGraph::Sink* CaptureGraph::sinkFor(const std::string& label) {
    return const_cast<Sink*>(static_cast<const CaptureGraph*>(this)->sinkFor(label));
}

bool CaptureGraph::padIsAudio(const std::string& label) const {
    const Sink* s = sinkFor(label);
    return s && s->audio;
}

int CaptureGraph::padWidth(const std::string& label) const {
    const Sink* s = sinkFor(label);
    return s && !s->audio && configured_ ? av_buffersink_get_w(s->ctx) : 0;
}

int CaptureGraph::padHeight(const std::string& label) const {
    const Sink* s = sinkFor(label);
    return s && !s->audio && configured_ ? av_buffersink_get_h(s->ctx) : 0;
}

std::vector<std::string> CaptureGraph::padLabels(bool audio) const {
    std::vector<std::string> out;
    for (const auto& s : sinks_) if (s->audio == audio) out.push_back(s->label);
    return out;
}

void CaptureGraph::readPads(const std::vector<std::string>& labels) {
    for (const auto& label : labels)
        if (Sink* s = sinkFor(label)) s->mapped = true;
}

int CaptureGraph::compositeWidth() const {
    return vprimary_ && configured_ ? av_buffersink_get_w(vprimary_->ctx) : 0;
}

int CaptureGraph::compositeHeight() const {
    return vprimary_ && configured_ ? av_buffersink_get_h(vprimary_->ctx) : 0;
}

double CaptureGraph::compositeRate() const {
    if (!vprimary_ || !configured_) return 0.0;
    const AVRational r = av_buffersink_get_frame_rate(vprimary_->ctx);
    return r.num > 0 && r.den > 0 ? av_q2d(r) : 0.0;
}

const Rgba* CaptureGraph::pictureOf(Sink& s) {
    const AVFrame* f = s.frame;
    if (!f->data[0] || f->width <= 0 || f->height <= 0) return nullptr;
    if (f->hw_frames_ctx) {
        // Unreachable through `open()`, which refuses a graph whose filters want
        // a device — but a filter given a device in its own arguments would land
        // here, and a picture with no pixels in it silently written as black is
        // the worst answer available.
        reportNote(AV_LOG_ERROR, "capture",
                   "[" + s.label + "] produced a picture on a graphics card, and a recording "
                   "has no path to bring one down");
        s.ended = true;
        return nullptr;
    }

    s.rgba.resize(std::max(1, f->width), std::max(1, f->height));
    if (f->format == AV_PIX_FMT_RGBA && f->width == s.rgba.width &&
        f->height == s.rgba.height) {
        const uint8_t* src = f->data[0];
        uint8_t* dst = s.rgba.data.data();
        for (int y = 0; y < s.rgba.height; ++y) {
            std::memcpy(dst, src, static_cast<size_t>(s.rgba.width) * 4);
            src += f->linesize[0];
            dst += s.rgba.stride;
        }
        return &s.rgba;
    }

    const auto fmt = static_cast<AVPixelFormat>(f->format);
    s.toRgba = sws_getCachedContext(s.toRgba, f->width, f->height, fmt, s.rgba.width,
                                    s.rgba.height, AV_PIX_FMT_RGBA, scalerFlag(scaler_),
                                    nullptr, nullptr, nullptr);
    if (!s.toRgba) return nullptr;
    setColorspace(s.toRgba, swsSpaceFor(f->colorspace, f->height),
                  f->color_range == AVCOL_RANGE_JPEG ? 1 : 0, SWS_CS_ITU709, 1);
    uint8_t* out[4] = {s.rgba.data.data(), nullptr, nullptr, nullptr};
    int stride[4] = {s.rgba.stride, 0, 0, 0};
    return sws_scale(s.toRgba, f->data, f->linesize, 0, f->height, out, stride) > 0 ? &s.rgba
                                                                                   : nullptr;
}

int CaptureGraph::soundOf(Sink& s) {
    const AVFrame* f = s.frame;
    if (f->nb_samples <= 0) return 0;
    const auto inFmt = static_cast<AVSampleFormat>(f->format);
    if (!s.swr || inFmt != s.swrFmt || f->sample_rate != s.swrRate) {
        if (s.swr) swr_free(&s.swr);
        AVChannelLayout out{};
        av_channel_layout_default(&out, channels_);
        const int rc = swr_alloc_set_opts2(&s.swr, &out, AV_SAMPLE_FMT_FLT, sampleRate_,
                                           &f->ch_layout, inFmt, f->sample_rate, 0, nullptr);
        av_channel_layout_uninit(&out);
        if (rc < 0 || !s.swr || swr_init(s.swr) < 0) return 0;
        s.swrFmt = inFmt;
        s.swrRate = f->sample_rate;
    }

    const int maxOut = static_cast<int>(
        av_rescale_rnd(swr_get_delay(s.swr, f->sample_rate) + f->nb_samples, sampleRate_,
                       f->sample_rate, AV_ROUND_UP));
    if (maxOut <= 0) return 0;
    // Slack past the samples asked for — see kSwrSlack in export_frame.h. A
    // vector sized to exactly the count is the mistake, however carefully the
    // count was worked out: libswresample stores a whole SIMD block at a time.
    s.samples.assign(static_cast<size_t>(maxOut) * channels_ + kSwrSlack, 0.0f);
    auto* dst = reinterpret_cast<uint8_t*>(s.samples.data());
    const int got = swr_convert(s.swr, &dst, maxOut,
                                const_cast<const uint8_t**>(f->extended_data), f->nb_samples);
    return std::max(0, got);
}

bool CaptureGraph::drain(const std::function<bool(const Taken&)>& emit, std::string* err) {
    if (!configured_) return true;

    // The composite first, so that the first picture out of a configured graph
    // is the canvas whenever there is one — which is what the recording's zero
    // is measured from, and which would otherwise be whichever pad the parse
    // happened to hand over first.
    std::vector<Sink*> order;
    order.reserve(sinks_.size());
    if (vprimary_) order.push_back(vprimary_);
    for (auto& s : sinks_) if (s.get() != vprimary_) order.push_back(s.get());

    for (Sink* sp : order) {
        Sink& s = *sp;
        while (!s.ended) {
            av_frame_unref(s.frame);
            const int rc = av_buffersink_get_frame(s.ctx, s.frame);
            if (rc == AVERROR(EAGAIN)) break;
            if (rc < 0) { s.ended = true; break; }

            // Whatever the graph measured about this frame, on its way past —
            // the same harvest `GraphSource::pull` does, in the one place every
            // sink is read from, so that a measuring filter during a recording
            // is nothing more than a filter in the graph.
            if (s.frame->metadata)
                reportFrameMetadata(s.audio, frameTime(s.ctx, s.frame), s.frame->metadata);

            // A pad nobody is writing is still emptied. libavfilter holds every
            // frame it has pushed at a sink until somebody takes it, and a
            // recording has no end for that to stop growing at.
            if (!s.mapped) continue;

            Taken t;
            t.label = s.label;
            t.audio = s.audio;
            t.primary = &s == (s.audio ? aprimary_ : vprimary_);
            t.at = frameTime(s.ctx, s.frame);
            if (s.audio) {
                t.frames = soundOf(s);
                if (t.frames <= 0) continue;
                t.samples = s.samples.data();
            } else {
                t.picture = pictureOf(s);
                if (!t.picture) continue;
            }
            if (!emit(t)) return false;
        }
        av_frame_unref(s.frame);
    }
    (void)err;
    return true;
}

} // namespace ffmpegbro
