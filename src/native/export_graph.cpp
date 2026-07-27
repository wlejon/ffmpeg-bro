// Rendering through libavfilter. See export_graph.h for why it is shaped
// this way.

#include "export_graph.h"

#include "export_source.h"
#include "ffmpeg_report.h"

#include "util/log.h"

extern "C" {
#include <libavutil/opt.h>
}

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace ffmpegbro {
namespace {

/// The type of one end of an unlinked pad. Read off the *instance's* pad array
/// rather than the filter's, because a filter with dynamic pads (`amix`,
/// `split`) has none until it has been given its arguments.
AVMediaType typeOfInput(const AVFilterInOut* io) {
    return avfilter_pad_get_type(io->filter_ctx->input_pads, io->pad_idx);
}

AVMediaType typeOfOutput(const AVFilterInOut* io) {
    return avfilter_pad_get_type(io->filter_ctx->output_pads, io->pad_idx);
}

const char* nameOf(const AVFilterInOut* io) { return io->name ? io->name : ""; }

/// When a frame leaving a sink says it happened, in seconds.
///
/// The sink's time base, not the render's: what a measuring filter attached to
/// this frame is a fact about *this* frame, and the honest timestamp for it is
/// the one the graph produced. A derived graph starts at zero because every
/// chain begins `setpts=PTS-STARTPTS`, so it reads as time into the render.
double frameTime(const AVFilterContext* sink, const AVFrame* f) {
    if (!f || f->pts == AV_NOPTS_VALUE) return -1.0;
    const AVRational tb = av_buffersink_get_time_base(sink);
    return tb.den > 0 ? f->pts * av_q2d(tb) : -1.0;
}

} // namespace

GraphSource::GraphSource(const ExportSettings& s) : settings_(s) {}

GraphSource::~GraphSource() {
    for (auto& f : feeds_)
        if (f->first) av_frame_free(&f->first);
    if (vframe_) av_frame_free(&vframe_);
    if (aframe_) av_frame_free(&aframe_);
    if (swr_) swr_free(&swr_);
    if (toRgba_) sws_freeContext(toRgba_);
    // The graph owns every filter in it, including the sources and sinks
    // linked in above, so this is the whole teardown.
    if (graph_) avfilter_graph_free(&graph_);
}

// ── Building ───────────────────────────────────────────────────────────────

bool GraphSource::build(std::string* err) {
    const auto fail = [err](const std::string& why) {
        if (err) *err = why;
        return false;
    };

    vframe_ = av_frame_alloc();
    aframe_ = av_frame_alloc();
    graph_ = avfilter_graph_alloc();
    if (!graph_ || !vframe_ || !aframe_) return fail("out of memory building the graph");

    AVFilterInOut* inputs = nullptr;
    AVFilterInOut* outputs = nullptr;
    int rc = avfilter_graph_parse2(graph_, settings_.filterGraph.c_str(), &inputs, &outputs);
    if (rc < 0) {
        avfilter_inout_free(&inputs);
        avfilter_inout_free(&outputs);
        return fail("the filter graph will not parse: " + avErr(rc));
    }

    bool ok = true;
    for (AVFilterInOut* in = inputs; in && ok; in = in->next) ok = attachInput(in, err);
    for (AVFilterInOut* out = outputs; out && ok; out = out->next) ok = attachOutput(out, err);
    avfilter_inout_free(&inputs);
    avfilter_inout_free(&outputs);
    if (!ok) return false;

    if (!vsink_) return fail("the filter graph has no picture coming out of it");

    rc = avfilter_graph_config(graph_, nullptr);
    if (rc < 0) return fail("the filter graph will not run: " + avErr(rc));

    // The graph decides its own output size, and the writer was opened for the
    // one in the settings. Caught here, where it can be said plainly, rather
    // than as a scaler quietly resizing every frame — unless the render asked
    // to follow the graph, in which case there is nothing to disagree with and
    // the answer is taken. Rounded down to even because yuv420p has no half
    // pixels; a graph that lands on an odd size gets a one-pixel resize on the
    // way into the canvas rather than an encoder that refuses.
    const int w = av_buffersink_get_w(vsink_), h = av_buffersink_get_h(vsink_);
    if (settings_.sizeFromGraph) {
        settings_.width = std::max(16, w & ~1);
        settings_.height = std::max(16, h & ~1);
    } else if (w != settings_.width || h != settings_.height) {
        return fail("the graph produces " + std::to_string(w) + "x" + std::to_string(h) +
                    " but the render is " + std::to_string(settings_.width) + "x" +
                    std::to_string(settings_.height));
    }

    const AVRational r = av_buffersink_get_frame_rate(vsink_);
    if (r.den > 0 && r.num > 0 && std::abs(av_q2d(r) - settings_.fps) > 0.01) {
        // Not fatal — the frames are stamped by the writer at the output rate
        // whatever arrives — but it means the graph and the render disagree
        // about how many frames a second is, and the result runs fast or slow.
        // Said into the report as well as the console, because it is exactly
        // the kind of thing that is only noticed at the end of a render and
        // only explicable if somebody wrote it down while it happened.
        char said[256];
        std::snprintf(said, sizeof(said),
                      "the graph runs at %.3f fps and the render at %.3f, so the result "
                      "will run fast or slow", av_q2d(r), settings_.fps);
        LOG_WARN("export: %s", said);
        reportNote(AV_LOG_WARNING, "graph", said);
    }
    return true;
}

bool GraphSource::attachInput(AVFilterInOut* in, std::string* err) {
    const std::string label = nameOf(in);
    const AVMediaType want = typeOfInput(in);

    const ExportGraphInput* match = nullptr;
    for (const auto& g : settings_.filterInputs)
        if (g.label == label) { match = &g; break; }
    if (!match) {
        if (err) *err = "the graph reads [" + label + "] and nothing says what feeds it";
        return false;
    }
    const bool audio = match->stream == "a";
    if (audio != (want == AVMEDIA_TYPE_AUDIO)) {
        if (err) *err = "[" + label + "] is fed " + (audio ? "sound" : "pictures") +
                        " and the filter it reaches wants the other";
        return false;
    }

    auto feed = std::make_unique<Feed>();
    feed->label = label;
    feed->audio = audio;
    if (!openFeed(*feed, *match, err)) return false;

    // Rotation, inserted here rather than left in the frames, because a display
    // matrix is metadata and a filter graph works on pictures. `ffmpeg`'s own
    // autorotate puts the same filters in the same place, which is what keeps
    // the printed command and this render the same picture.
    AVFilterContext* tail = feed->src;
    if (!audio && feed->video) {
        const int quarters = ((feed->video->rotation() % 360) + 360) % 360 / 90;
        for (int i = 0; i < quarters; ++i) {
            AVFilterContext* t = nullptr;
            const std::string name = "rot_" + label + "_" + std::to_string(i);
            int rc = avfilter_graph_create_filter(&t, avfilter_get_by_name("transpose"),
                                                  name.c_str(), "clock", nullptr, graph_);
            if (rc < 0 || (rc = avfilter_link(tail, 0, t, 0)) < 0) {
                if (err) *err = "cannot turn [" + label + "] the right way up: " + avErr(rc);
                return false;
            }
            tail = t;
        }
    }

    const int rc = avfilter_link(tail, 0, in->filter_ctx, in->pad_idx);
    if (rc < 0) {
        if (err) *err = "cannot connect [" + label + "] to the graph: " + avErr(rc);
        return false;
    }
    feeds_.push_back(std::move(feed));
    return true;
}

bool GraphSource::openFeed(Feed& feed, const ExportGraphInput& want, std::string* err) {
    AVBufferSrcParameters* par = av_buffersrc_parameters_alloc();
    if (!par) { if (err) *err = "out of memory"; return false; }

    const AVFilter* kind = avfilter_get_by_name(feed.audio ? "abuffer" : "buffer");
    const std::string name = (feed.audio ? "in_a_" : "in_v_") + feed.label;
    feed.src = avfilter_graph_alloc_filter(graph_, kind, name.c_str());
    if (!feed.src) {
        av_free(par);
        if (err) *err = "this build has no buffer source to feed the graph from";
        return false;
    }

    if (!feed.audio) {
        feed.video = std::make_unique<SourceVideo>();
        std::string open;
        const AVFrame* f = nullptr;
        if (feed.video->open(resolveInput(settings_, want.input, want.path), &open)) {
            // Where this pad's window begins. Without it every input decodes
            // from the start of its file — which is what `-filter_complex`
            // without `-ss` does, and what makes a clip an hour in take an
            // hour to start. `seekTo` is a backward seek, so it lands at or
            // before what it is given and the `trim` in the graph still gets
            // every frame it asked for; the frames keep their file
            // timestamps, which is what `trim` matches on.
            if (want.from > 0.0) feed.video->seekTo(want.from);
            f = feed.video->nextRaw();
        }
        if (!f) {
            av_free(par);
            if (err) *err = open.empty() ? want.path + ": nothing decodes out of it" : open;
            return false;
        }
        feed.first = av_frame_clone(f);
        par->format = f->format;
        par->width = f->width;
        par->height = f->height;
        par->sample_aspect_ratio = f->sample_aspect_ratio.num ? f->sample_aspect_ratio
                                                              : AVRational{1, 1};
        par->color_space = f->colorspace;
        par->color_range = f->color_range;
        par->time_base = feed.video->timeBase();
    } else {
        feed.sound = std::make_unique<SourceAudio>();
        const AVFrame* f = nullptr;
        if (feed.sound->open(resolveInput(settings_, want.input, want.path),
                             settings_.audioSampleRate, settings_.audioChannels)) {
            // The same seek, and safe for the same reason. `nextRaw` reads the
            // decoder directly rather than through the fifo, so none of the
            // sample-accurate trimming `fill()` does after a seek applies
            // here: the frames come out with their own timestamps and `atrim`
            // is what cuts them.
            if (want.from > 0.0) feed.sound->seekTo(want.from);
            f = feed.sound->nextRaw();
        }
        if (f) {
            feed.first = av_frame_clone(f);
            par->format = f->format;
            par->sample_rate = f->sample_rate;
            av_channel_layout_copy(&par->ch_layout, &f->ch_layout);
            par->time_base = feed.sound->timeBase();
        } else {
            // A file with no sound is not an error — a silent clip is a clip.
            // It becomes an input that ends before it starts, which `atrim`,
            // `adelay` and `amix` all already know what to do with, and which
            // comes out of the graph as the silence it is.
            feed.sound.reset();
            par->format = AV_SAMPLE_FMT_FLT;
            par->sample_rate = settings_.audioSampleRate;
            av_channel_layout_default(&par->ch_layout, settings_.audioChannels);
            par->time_base = AVRational{1, settings_.audioSampleRate};
        }
    }

    int rc = av_buffersrc_parameters_set(feed.src, par);
    av_channel_layout_uninit(&par->ch_layout);
    av_free(par);
    if (rc >= 0) rc = avfilter_init_dict(feed.src, nullptr);
    if (rc < 0) {
        if (err) *err = "cannot describe [" + feed.label + "] to the graph: " + avErr(rc);
        return false;
    }
    return true;
}

bool GraphSource::attachOutput(AVFilterInOut* out, std::string* err) {
    const bool audio = typeOfOutput(out) == AVMEDIA_TYPE_AUDIO;
    AVFilterContext*& slot = audio ? asink_ : vsink_;
    if (slot) {
        if (err) *err = std::string("the graph has two ") + (audio ? "sound" : "picture") +
                        " outputs and a render writes one";
        return false;
    }

    const char* kind = audio ? "abuffersink" : "buffersink";
    const std::string name = std::string("out_") + (audio ? "a" : "v");
    int rc = avfilter_graph_create_filter(&slot, avfilter_get_by_name(kind), name.c_str(),
                                          nullptr, nullptr, graph_);
    if (rc >= 0) rc = avfilter_link(out->filter_ctx, out->pad_idx, slot, 0);
    if (rc < 0) {
        if (err) *err = std::string("cannot take the ") + (audio ? "sound" : "picture") +
                        " out of the graph: " + avErr(rc);
        return false;
    }
    // Nothing is asked of the sink's format: the graph settles on its own, and
    // what comes out is converted here, where the colour tags of the frame are
    // to hand. Constraining it would be the same conversion done by a filter
    // libavfilter inserts, with the tags guessed instead of read.
    return true;
}

// ── Running ────────────────────────────────────────────────────────────────

bool GraphSource::pushOne(Feed& feed) {
    if (feed.closed) return false;

    if (feed.first) {
        av_buffersrc_add_frame(feed.src, feed.first);
        av_frame_free(&feed.first);
        return true;
    }

    const AVFrame* next = feed.audio ? (feed.sound ? feed.sound->nextRaw() : nullptr)
                                     : (feed.video ? feed.video->nextRaw() : nullptr);
    if (!next) {
        av_buffersrc_add_frame(feed.src, nullptr);
        feed.closed = true;
        return true;
    }
    av_buffersrc_add_frame_flags(feed.src, const_cast<AVFrame*>(next),
                                 AV_BUFFERSRC_FLAG_KEEP_REF);
    return true;
}

bool GraphSource::pushSome() {
    // Feed only what the graph asked for. A request that reached a buffer
    // source and found it empty is counted there, which is exactly the list of
    // inputs holding the render up; feeding the others as well would read a
    // whole file ahead of the one frame anybody wanted.
    int starved = 0;
    for (auto& f : feeds_)
        if (!f->closed && av_buffersrc_get_nb_failed_requests(f->src) > 0) ++starved;

    bool pushed = false;
    for (auto& f : feeds_) {
        if (f->closed) continue;
        // With nothing reported starved there is no information to act on —
        // which happens on the first pull, before any request has been made —
        // so everything gets one frame and the count is meaningful next time.
        if (starved > 0 && av_buffersrc_get_nb_failed_requests(f->src) == 0) continue;
        if (pushOne(*f)) pushed = true;
    }
    return pushed;
}

int GraphSource::pull(AVFilterContext* sink, AVFrame* into) {
    for (;;) {
        const int rc = av_buffersink_get_frame(sink, into);
        if (rc != AVERROR(EAGAIN)) {
            // Whatever the graph measured about this frame, on its way past.
            //
            // A whole family of filters — cropdetect, blackdetect,
            // silencedetect, ebur128, signalstats, psnr, ssim — answers a
            // question rather than changing a picture, and libavfilter's way of
            // answering is to hang the numbers on the frame. Harvested here, in
            // the one place both sinks are read from, so that adding a measuring
            // filter to a graph is all anybody has to do to see its numbers.
            // Costs a null check per frame when there are none, which is every
            // render that is not measuring anything.
            if (rc >= 0 && into->metadata)
                reportFrameMetadata(sink == asink_, frameTime(sink, into), into->metadata);
            return rc;
        }
        if (!pushSome()) return AVERROR_EOF;
    }
}

const Rgba& GraphSource::canvasAt(double) {
    canvas_.resize(settings_.width, settings_.height);

    const auto black = [this]() -> const Rgba& {
        std::fill(canvas_.data.begin(), canvas_.data.end(), uint8_t{0});
        return canvas_;
    };
    if (videoEnded_) return black();

    av_frame_unref(vframe_);
    if (pull(vsink_, vframe_) < 0) {
        // The graph has run out before the render has. Black, not a freeze on
        // the last picture: that is what the track stack shows when nothing
        // covers the playhead, and a still frame would read as a stall.
        videoEnded_ = true;
        return black();
    }

    if (vframe_->format == AV_PIX_FMT_RGBA) {
        const uint8_t* src = vframe_->data[0];
        uint8_t* dst = canvas_.data.data();
        for (int y = 0; y < canvas_.height; ++y) {
            std::memcpy(dst, src, static_cast<size_t>(canvas_.width) * 4);
            src += vframe_->linesize[0];
            dst += canvas_.stride;
        }
        return canvas_;
    }

    // A graph that ends somewhere other than RGBA still renders; it just pays
    // for a conversion the writer will partly undo. Done with the frame's own
    // tags rather than swscale's default, which is BT.601 whatever the picture
    // says it is.
    const auto fmt = static_cast<AVPixelFormat>(vframe_->format);
    toRgba_ = sws_getCachedContext(toRgba_, vframe_->width, vframe_->height, fmt,
                                   canvas_.width, canvas_.height, AV_PIX_FMT_RGBA,
                                   scalerFlag(settings_.scaler), nullptr, nullptr, nullptr);
    if (!toRgba_) return black();
    setColorspace(toRgba_, swsSpaceFor(vframe_->colorspace, vframe_->height),
                  vframe_->color_range == AVCOL_RANGE_JPEG ? 1 : 0, SWS_CS_ITU709, 1);
    uint8_t* dst[4] = {canvas_.data.data(), nullptr, nullptr, nullptr};
    int stride[4] = {canvas_.stride, 0, 0, 0};
    if (sws_scale(toRgba_, vframe_->data, vframe_->linesize, 0, vframe_->height, dst,
                  stride) <= 0)
        return black();
    return canvas_;
}

// ── Sound ──────────────────────────────────────────────────────────────────

int GraphSource::available() const {
    const int ch = std::max(1, settings_.audioChannels);
    return static_cast<int>((fifo_.size() - head_) / ch);
}

void GraphSource::takeSamples(const AVFrame* f) {
    const auto inFmt = static_cast<AVSampleFormat>(f->format);
    const int channels = std::max(1, settings_.audioChannels);
    if (!swr_ || inFmt != swrFmt_ || f->sample_rate != swrRate_) {
        if (swr_) swr_free(&swr_);
        AVChannelLayout out{};
        av_channel_layout_default(&out, channels);
        const int rc = swr_alloc_set_opts2(&swr_, &out, AV_SAMPLE_FMT_FLT,
                                           settings_.audioSampleRate, &f->ch_layout, inFmt,
                                           f->sample_rate, 0, nullptr);
        av_channel_layout_uninit(&out);
        if (rc < 0 || !swr_ || swr_init(swr_) < 0) return;
        swrFmt_ = inFmt;
        swrRate_ = f->sample_rate;
    }

    const int64_t delay = swr_get_delay(swr_, settings_.audioSampleRate);
    const int maxOut = static_cast<int>(av_rescale_rnd(
        delay + f->nb_samples, settings_.audioSampleRate, f->sample_rate, AV_ROUND_UP));
    if (maxOut <= 0) return;

    // Slack past the samples asked for, for the reason Rgba::kSwsSlack exists:
    // libswresample writes a whole SIMD block at a time and the last store of a
    // run goes past the count it was given. A vector sized to exactly the
    // sample count is the mistake, and it corrupts the heap far enough from the
    // write to read as a bug in whatever ran next.
    static constexpr size_t kSwrSlack = 64;
    const size_t base = fifo_.size();
    fifo_.resize(base + static_cast<size_t>(maxOut) * channels + kSwrSlack);
    auto* dst = reinterpret_cast<uint8_t*>(fifo_.data() + base);
    const int written = swr_convert(swr_, &dst, maxOut,
                                    const_cast<const uint8_t**>(f->extended_data),
                                    f->nb_samples);
    fifo_.resize(base + static_cast<size_t>(std::max(0, written)) * channels);
}

/// The rate and channel count are the settings' — the graph was configured for
/// them and the job asks with them — so the parameters that say so again are
/// not read. One place decides what the sound of a render is.
void GraphSource::mixInto(float* dst, double, int frames, int, int) {
    if (!asink_) return;
    const int channels = std::max(1, settings_.audioChannels);

    int done = 0;
    while (done < frames) {
        if (available() == 0) {
            if (audioEnded_) break;
            av_frame_unref(aframe_);
            if (pull(asink_, aframe_) < 0) { audioEnded_ = true; break; }
            takeSamples(aframe_);
            continue;
        }
        const int n = std::min(frames - done, available());
        const float* src = fifo_.data() + head_;
        const int count = n * channels;
        for (int i = 0; i < count; ++i) dst[done * channels + i] += src[i];
        head_ += static_cast<size_t>(count);
        done += n;
        if (head_ >= 65536) {
            fifo_.erase(fifo_.begin(), fifo_.begin() + static_cast<long>(head_));
            head_ = 0;
        }
    }

    // The graph has already mixed; this only has to stay in range, which
    // several `amix` inputs summed with `normalize=0` need as much as the
    // compositor's own mixer does.
    const size_t total = static_cast<size_t>(frames) * channels;
    for (size_t i = 0; i < total; ++i)
        dst[i] = dst[i] < -1.0f ? -1.0f : (dst[i] > 1.0f ? 1.0f : dst[i]);
}

} // namespace ffmpegbro
