#include "playback_filter.h"

#include "export_frame.h"   // avErr, rotationOf — one reading of both in this binary

#include "util/log.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
}

#include <cmath>
#include <map>
#include <mutex>

namespace ffmpegbro {
namespace {

/// A token, not a path. Starts with a slash for the reason `defineInput`'s does
/// — bro resolves anything that does not against the document — and says what
/// it is, because it turns up in logs beside real filenames.
const char* kPrefix = "/@fx/";

std::mutex& lock() {
    static std::mutex m;
    return m;
}

/// A registered view, and what it turned out to produce.
///
/// The facts are kept beside the view rather than worked out again because
/// `defineSettled` exists: they are about the input and the chains, and a view
/// re-registered with the same two has the same answer. See the header.
struct Registered {
    PlaybackView view;
    ViewFacts facts;
    bool settled = false;
};

std::map<std::string, Registered>& table() {
    static std::map<std::string, Registered> t;
    return t;
}

/// Do these two views produce the same thing? Everything but the clock.
bool sameShape(const PlaybackView& a, const PlaybackView& b) {
    return a.video == b.video && a.audio == b.audio && a.input == b.input;
}

/// The rotation, as the filters that undo it.
///
/// One `transpose=clock` per quarter turn, which is what `ffmpeg`'s own
/// autorotate inserts and what `GraphSource::attachInput` builds out of filter
/// contexts. Written as text here because this graph is parsed from text and a
/// second way of saying it would be a second thing to keep in step.
std::string turnUpright(int degrees) {
    const int quarters = ((degrees % 360) + 360) % 360 / 90;
    std::string out;
    for (int i = 0; i < quarters; ++i) out += "transpose=clock,";
    return out;
}

/// Is this a format whose pixels are on a card?
///
/// Asked of the descriptor rather than of a list of names, for the reason every
/// list in this binary is asked of libav: `cuda`, `d3d11`, `qsv`, `vaapi` and
/// whatever the next one is all answer the same way.
bool onDevice(int format) {
    const AVPixFmtDescriptor* d = av_pix_fmt_desc_get(static_cast<AVPixelFormat>(format));
    return d && (d->flags & AV_PIX_FMT_FLAG_HWACCEL);
}

}  // namespace

// ── The registry ───────────────────────────────────────────────────────────

std::string viewToken(const std::string& id) {
    return std::string(kPrefix) + id;
}

std::string defineView(const std::string& id, const PlaybackView& v) {
    {
        std::lock_guard<std::mutex> g(lock());
        Registered& r = table()[id];
        if (!sameShape(r.view, v)) r.settled = false;
        r.view = v;
    }
    return viewToken(id);
}

void forgetView(const std::string& id) {
    std::lock_guard<std::mutex> g(lock());
    table().erase(id);
}

bool resolveView(const std::string& src, PlaybackView* out) {
    const std::string prefix(kPrefix);
    if (src.compare(0, prefix.size(), prefix) != 0) return false;
    std::lock_guard<std::mutex> g(lock());
    auto it = table().find(src.substr(prefix.size()));
    if (it == table().end()) return false;
    if (out) *out = it->second.view;
    return true;
}

// ── One stream, decoded and filtered ───────────────────────────────────────

StreamFilter::StreamFilter() = default;

StreamFilter::~StreamFilter() {
    reset();
    if (dec_) avcodec_free_context(&dec_);
    if (frame_) av_frame_free(&frame_);
    if (layout_) {
        av_channel_layout_uninit(layout_);
        av_freep(&layout_);
    }
}

int StreamFilter::channels() const {
    return layout_ ? layout_->nb_channels : 0;
}

bool StreamFilter::open(AVFormatContext* fmt, int streamIndex, const MediaInput& in,
                        const std::string& chain, int rotation, double shift,
                        std::string* err) {
    if (!fmt || streamIndex < 0 || streamIndex >= static_cast<int>(fmt->nb_streams)) {
        if (err) *err = "no such stream to filter";
        return false;
    }
    AVStream* st = fmt->streams[streamIndex];
    audio_ = st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO;
    index_ = streamIndex;
    chain_ = chain;
    rotation_ = audio_ ? 0 : rotation;
    shift_ = shift;
    tbNum_ = st->time_base.num;
    tbDen_ = st->time_base.den;
    const AVRational fr = av_guess_frame_rate(fmt, st, nullptr);
    frNum_ = fr.num;
    frDen_ = fr.den;

    // Threaded, exactly as playback's own decoder is: a filtered 4K clip is
    // still a 4K decode and the filters are rarely the slow half. The input's
    // own decoder options are applied by `openDecoder` and therefore win, which
    // is what keeps `-skip_frame` meaning the same thing with a filter on the
    // clip and without one.
    if (!openDecoder(&dec_, st->codecpar, st->time_base, in, /*threaded=*/true, err))
        return false;

    frame_ = av_frame_alloc();
    if (!frame_) {
        if (err) *err = "out of memory";
        return false;
    }
    return true;
}

void StreamFilter::reset() {
    if (dec_) avcodec_flush_buffers(dec_);
    // The whole graph, not merely its state: libavfilter has no flush, and a
    // filter carrying the moment before a seek across it is one wrong frame
    // per scrub. See the note in the header.
    if (graph_) avfilter_graph_free(&graph_);
    graph_ = nullptr;
    src_ = nullptr;
    sink_ = nullptr;
}

bool StreamFilter::build(const AVFrame* first, std::string* err) {
    graph_ = avfilter_graph_alloc();
    if (!graph_) {
        if (err) *err = "out of memory";
        return false;
    }

    // ── the top: a buffer source described by the frame that has arrived ────
    const AVFilter* srcKind = avfilter_get_by_name(audio_ ? "abuffer" : "buffer");
    const AVFilter* sinkKind = avfilter_get_by_name(audio_ ? "abuffersink" : "buffersink");
    if (!srcKind || !sinkKind) {
        if (err) *err = "this build has no buffer source to feed a filter from";
        return false;
    }
    src_ = avfilter_graph_alloc_filter(graph_, srcKind, "in");
    if (!src_) {
        if (err) *err = "out of memory";
        return false;
    }

    AVBufferSrcParameters* par = av_buffersrc_parameters_alloc();
    if (!par) {
        if (err) *err = "out of memory";
        return false;
    }
    par->format = first->format;
    par->time_base = AVRational{tbNum_, tbDen_};
    if (audio_) {
        par->sample_rate = first->sample_rate;
        av_channel_layout_copy(&par->ch_layout, &first->ch_layout);
    } else {
        par->width = first->width;
        par->height = first->height;
        par->sample_aspect_ratio =
            first->sample_aspect_ratio.num ? first->sample_aspect_ratio : AVRational{1, 1};
        par->color_space = first->colorspace;
        par->color_range = first->color_range;
        par->frame_rate = AVRational{frNum_, frDen_};
        // A picture still on the card has to say which pool it came from before
        // the graph is configured, or libavfilter negotiates formats for a
        // frame it has never seen. It cannot survive to the end of this chain —
        // see the refusal below — but it can perfectly well go *through* one,
        // and failing at the link with a message about pixel formats would say
        // nothing about hardware at all.
        if (first->hw_frames_ctx) par->hw_frames_ctx = av_buffer_ref(first->hw_frames_ctx);
    }
    int rc = av_buffersrc_parameters_set(src_, par);
    av_channel_layout_uninit(&par->ch_layout);
    if (par->hw_frames_ctx) av_buffer_unref(&par->hw_frames_ctx);
    av_free(par);
    if (rc >= 0) rc = avfilter_init_dict(src_, nullptr);
    if (rc < 0) {
        if (err) *err = "cannot describe the stream to the filters: " + avErr(rc);
        return false;
    }

    // ── the bottom: a sink asked for nothing ───────────────────────────────
    //
    // No format is imposed. What comes out is handed to bro's own decoder side,
    // which converts whatever it is given — so constraining it here would be
    // the same conversion done twice, once by a filter libavfilter inserts and
    // once by the scaler that was going to run anyway.
    rc = avfilter_graph_create_filter(&sink_, sinkKind, "out", nullptr, nullptr, graph_);
    if (rc < 0) {
        if (err) *err = "cannot take the frames out of the filters: " + avErr(rc);
        return false;
    }

    // ── the middle: what somebody actually asked for ───────────────────────
    std::string text = turnUpright(rotation_) + chain_;
    // A chain of nothing is not a graph libavfilter will parse, and a rotation
    // with no filters after it is a perfectly ordinary thing to want.
    if (text.empty()) text = audio_ ? "anull" : "null";
    else if (text.back() == ',') text += audio_ ? "anull" : "null";

    AVFilterInOut* outputs = avfilter_inout_alloc();   // where the graph reads
    AVFilterInOut* inputs = avfilter_inout_alloc();    // where the graph writes
    if (!outputs || !inputs) {
        avfilter_inout_free(&outputs);
        avfilter_inout_free(&inputs);
        if (err) *err = "out of memory";
        return false;
    }
    outputs->name = av_strdup("in");
    outputs->filter_ctx = src_;
    outputs->pad_idx = 0;
    outputs->next = nullptr;
    inputs->name = av_strdup("out");
    inputs->filter_ctx = sink_;
    inputs->pad_idx = 0;
    inputs->next = nullptr;

    rc = avfilter_graph_parse_ptr(graph_, text.c_str(), &inputs, &outputs, nullptr);
    avfilter_inout_free(&inputs);
    avfilter_inout_free(&outputs);
    if (rc < 0) {
        // libavfilter's own code, turned into libav's own sentence — "Option
        // not found", "Filter not found". The line that *names* the filter and
        // the option went to `av_log` on the way here and is in the report with
        // every other libav message, which is where this application has always
        // put them; what a caller gets back is the sentence, which is what fits
        // beside a control.
        if (err) *err = avErr(rc);
        return false;
    }
    rc = avfilter_graph_config(graph_, nullptr);
    if (rc < 0) {
        if (err) *err = avErr(rc);
        return false;
    }

    const AVRational otb = av_buffersink_get_time_base(sink_);
    outNum_ = otb.num;
    outDen_ = otb.den;
    format_ = av_buffersink_get_format(sink_);
    if (audio_) {
        sampleRate_ = av_buffersink_get_sample_rate(sink_);
        if (!layout_)
            layout_ = static_cast<AVChannelLayout*>(av_mallocz(sizeof(AVChannelLayout)));
        AVChannelLayout got{};
        if (!layout_ || av_buffersink_get_ch_layout(sink_, &got) < 0 ||
            av_channel_layout_copy(layout_, &got) < 0) {
            av_channel_layout_uninit(&got);
            if (err) *err = "the filters produce a sound with no channel layout";
            return false;
        }
        av_channel_layout_uninit(&got);
        srcW_ = srcH_ = 0;
    } else {
        width_ = av_buffersink_get_w(sink_);
        height_ = av_buffersink_get_h(sink_);
        // What went in, the right way up — which is what the turn above makes
        // it, so a portrait phone clip reports the portrait size a caller
        // comparing "did the chain change the shape" has to compare against.
        const int quarters = ((rotation_ % 360) + 360) % 360 / 90;
        srcW_ = quarters % 2 ? first->height : first->width;
        srcH_ = quarters % 2 ? first->width : first->height;
        // **The screen reads pixels.** bro's renderer takes planes it can
        // touch, so a chain that ends on a card is one nothing can draw — and
        // it is a real thing to type, since `hwupload` is in the palette. Said
        // here rather than left to fail at the first frame, where it would be a
        // black element and a line in a log.
        if (onDevice(format_)) {
            if (err)
                *err = "these filters leave the picture on the graphics card, and the "
                       "viewer draws pixels — put an `hwdownload` on the end of them";
            return false;
        }
    }
    return true;
}

bool StreamFilter::push(const AVPacket* pkt, std::string* err) {
    if (!dec_) return false;
    for (int tries = 0; tries < 2; ++tries) {
        const int rc = avcodec_send_packet(dec_, pkt);
        if (rc == AVERROR(EAGAIN)) {
            if (!drain(err)) return false;
            continue;   // and offer the same packet again
        }
        if (rc < 0 && rc != AVERROR_EOF) {
            // A corrupt packet is not a reason to tear the graph down — the
            // next keyframe recovers, exactly as the unfiltered path does.
            LOG_WARN("ffmpeg: filtered decode error: %s", avErr(rc).c_str());
            return true;
        }
        break;
    }
    if (!drain(err)) return false;
    // End of stream, handed on so a filter holding frames back lets them go.
    if (!pkt && graph_) av_buffersrc_add_frame_flags(src_, nullptr, 0);
    return true;
}

bool StreamFilter::drain(std::string* err) {
    if (!dec_) return false;
    for (;;) {
        av_frame_unref(frame_);
        int rc = avcodec_receive_frame(dec_, frame_);
        if (rc < 0) break;
        if (!graph_ && !build(frame_, err)) return false;
        // The render's clock, so `enable=` names the moment the timeline means.
        // Applied here and taken off in `take`, which between them are the
        // whole of `PlaybackView::shift`.
        if (frame_->pts != AV_NOPTS_VALUE && shift_ != 0.0)
            frame_->pts += av_rescale_q(static_cast<int64_t>(llround(shift_ * 1e9)),
                                        AVRational{1, 1000000000}, AVRational{tbNum_, tbDen_});
        // KEEP_REF: `frame_` is this object's scratch and is unreferenced at the
        // top of the next turn round this loop.
        rc = av_buffersrc_add_frame_flags(src_, frame_, AV_BUFFERSRC_FLAG_KEEP_REF);
        if (rc < 0) {
            if (err) *err = "the filters would not take the frame: " + avErr(rc);
            return false;
        }
    }
    return true;
}

AVFrame* StreamFilter::take() {
    if (!graph_ || !sink_) return nullptr;
    AVFrame* f = av_frame_alloc();
    if (!f) return nullptr;
    if (av_buffersink_get_frame(sink_, f) < 0) {
        av_frame_free(&f);
        return nullptr;
    }
    // Back onto the stream's own clock, and onto the stream's own time base
    // with it: a chain with an `fps` in it renumbers, and the caller stamps
    // packets from this.
    if (f->pts != AV_NOPTS_VALUE) {
        f->pts = av_rescale_q(f->pts, AVRational{outNum_, outDen_}, AVRational{tbNum_, tbDen_});
        if (shift_ != 0.0)
            f->pts -= av_rescale_q(static_cast<int64_t>(llround(shift_ * 1e9)),
                                   AVRational{1, 1000000000}, AVRational{tbNum_, tbDen_});
    }
    return f;
}

// ── Settling ───────────────────────────────────────────────────────────────

bool settleFilter(AVFormatContext* fmt, StreamFilter& f, std::string* err) {
    if (f.ready()) return true;
    AVPacket* pkt = av_packet_alloc();
    if (!pkt) {
        if (err) *err = "out of memory";
        return false;
    }
    bool ok = true;
    for (;;) {
        av_packet_unref(pkt);
        const int rc = av_read_frame(fmt, pkt);
        if (rc < 0) {
            // Flushed rather than given up on: a decoder with frames in hand
            // has not produced one yet and the graph is built from the first
            // that arrives.
            ok = f.push(nullptr, err);
            break;
        }
        if (pkt->stream_index != f.index()) continue;
        if (!(ok = f.push(pkt, err))) break;
        if (f.ready()) break;
    }
    av_packet_free(&pkt);
    if (ok && !f.ready()) {
        if (err && err->empty()) *err = "nothing decodes out of this stream to filter";
        ok = false;
    }
    return ok;
}

bool settleView(const PlaybackView& v, ViewFacts* facts, std::string* err) {
    if (v.video.empty() && v.audio.empty()) {
        if (err) *err = "a view with no filters in it is the input itself";
        return false;
    }
    AVFormatContext* fmt = nullptr;
    if (!openInput(&fmt, v.input, err)) return false;

    bool ok = true;
    for (int pass = 0; pass < 2 && ok; ++pass) {
        const bool audio = pass == 1;
        const std::string& chain = audio ? v.audio : v.video;
        if (chain.empty()) continue;
        const int want = audio ? AVMEDIA_TYPE_AUDIO : AVMEDIA_TYPE_VIDEO;
        int index = -1;
        for (unsigned i = 0; i < fmt->nb_streams && index < 0; ++i) {
            if (fmt->streams[i]->codecpar->codec_type != want) continue;
            // Cover art is a still stapled into an audio file, and filtering it
            // would be filtering a JPEG. The same skip playback makes.
            if (!audio && (fmt->streams[i]->disposition & AV_DISPOSITION_ATTACHED_PIC)) continue;
            index = static_cast<int>(i);
        }
        // Not an error: a filter on the sound of a file with no sound is a
        // filter that does nothing, and the caller is told which halves settled
        // rather than being refused over the half that was never there.
        if (index < 0) continue;

        StreamFilter f;
        const int rotation = audio ? 0 : rotationOf(fmt->streams[index]);
        // Zero: a settle asks what the chain *produces*, and the clock it
        // produces it on has no bearing on that.
        ok = f.open(fmt, index, v.input, chain, rotation, 0.0, err) &&
             settleFilter(fmt, f, err);
        if (!ok) break;
        // Back to the top, so the next stream's settle reads the whole file
        // rather than whatever is left of it.
        avformat_seek_file(fmt, -1, INT64_MIN, 0, INT64_MAX, 0);
        if (!facts) continue;
        if (audio) {
            facts->audio = true;
            facts->sampleRate = f.sampleRate();
            facts->channels = f.channels();
        } else {
            facts->video = true;
            facts->width = f.width();
            facts->height = f.height();
            facts->sourceWidth = f.sourceWidth();
            facts->sourceHeight = f.sourceHeight();
        }
    }
    avformat_close_input(&fmt);
    return ok;
}

bool defineSettled(const std::string& id, const PlaybackView& v, ViewFacts* facts,
                   std::string* token, std::string* err) {
    {
        std::lock_guard<std::mutex> g(lock());
        auto it = table().find(id);
        if (it != table().end() && it->second.settled && sameShape(it->second.view, v)) {
            // Only the clock moved. Registered again so the source opened after
            // this reads the new one, and nothing is opened to find that out.
            it->second.view = v;
            if (facts) *facts = it->second.facts;
            if (token) *token = viewToken(id);
            return true;
        }
    }

    ViewFacts got;
    // Outside the lock, because settling opens a file and decodes a frame and
    // the registry is read by every element that starts playing. Two callers
    // settling one id at once would each do the work and the second would win,
    // which is the same answer twice and no worse than a stall.
    if (!settleView(v, &got, err)) return false;

    {
        std::lock_guard<std::mutex> g(lock());
        Registered& r = table()[id];
        r.view = v;
        r.facts = got;
        r.settled = true;
    }
    if (facts) *facts = got;
    if (token) *token = viewToken(id);
    return true;
}

}  // namespace ffmpegbro
