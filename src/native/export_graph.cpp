// Rendering through libavfilter. See export_graph.h for why it is shaped
// this way.

#include "export_graph.h"

#include "export_source.h"
#include "ffmpeg_hardware.h"
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

/// `avfilter_graph_parse2`, in the three steps it is made of, so that a device
/// can be handed to the filters that need one *between* being created and being
/// initialised.
///
/// **`hwupload` refuses to initialise without a device**, and there is nowhere
/// to put one: the filter takes no argument that could name it and reads
/// `AVFilterContext::hw_device_ctx`, which does not exist until the filter does.
/// `avfilter_graph_parse2` creates and initialises in one call, so a device
/// assigned after it has already come too late — "A hardware device reference is
/// required to upload frames to", from inside a parse, with nothing in the
/// message about which filter meant it.
///
/// The segment API is the seam ffmpeg's own CLI uses for exactly this, and this
/// is `graph_parse()` in `ffmpeg_filter.c` written out. With no device named it
/// is `avfilter_graph_parse2` in three lines instead of one, which is why there
/// is no fast path here to disagree with.
int GraphSource::parseGraph(AVFilterInOut** inputs, AVFilterInOut** outputs) {
    AVFilterGraphSegment* seg = nullptr;
    int rc = avfilter_graph_segment_parse(graph_, settings_.filterGraph.c_str(), 0, &seg);
    if (rc < 0) return rc;

    rc = avfilter_graph_segment_create_filters(seg, 0);
    if (rc >= 0 && hwDevice_) {
        // Every filter that declared it wants one gets the device the render
        // named. A filter that was given its own in its arguments keeps it:
        // `-filter_hw_device` is the default, not an override.
        for (unsigned i = 0; i < graph_->nb_filters && rc >= 0; ++i) {
            AVFilterContext* f = graph_->filters[i];
            if (!f->filter || !(f->filter->flags & AVFILTER_FLAG_HWDEVICE)) continue;
            if (f->hw_device_ctx) continue;
            f->hw_device_ctx = av_buffer_ref(hwDevice_);
            if (!f->hw_device_ctx) rc = AVERROR(ENOMEM);
        }
    }
    if (rc >= 0) rc = avfilter_graph_segment_apply(seg, 0, inputs, outputs);
    avfilter_graph_segment_free(&seg);
    return rc;
}

GraphSource::Feed::~Feed() {
    if (first) av_frame_free(&first);
}

/// Everything one sink owns, given back. `ctx` is the graph's and goes with it.
GraphSource::Sink::~Sink() {
    if (frame) av_frame_free(&frame);
    if (down) av_frame_free(&down);
    if (toRgba) sws_freeContext(toRgba);
    if (swr) swr_free(&swr);
}

GraphSource::~GraphSource() {
    if (toCanvas_) sws_freeContext(toCanvas_);
    // Before the graph, because each sink holds a filter context the graph owns
    // and reading the teardown the other way round invites somebody to touch one
    // after it has gone.
    sinks_.clear();
    vprimary_ = aprimary_ = nullptr;
    // The graph owns every filter in it, including the sources and sinks
    // linked in above, so this is the whole teardown.
    if (graph_) avfilter_graph_free(&graph_);
    // After the graph, because each filter it held has its own reference to
    // this and dropping ours first would say nothing but is the wrong order to
    // read.
    if (hwDevice_) av_buffer_unref(&hwDevice_);
}

// ── Building ───────────────────────────────────────────────────────────────

bool GraphSource::build(std::string* err) {
    const auto fail = [err](const std::string& why) {
        if (err) *err = why;
        return false;
    };

    graph_ = avfilter_graph_alloc();
    if (!graph_) return fail("out of memory building the graph");

    // `-filter_hw_device`: the device every filter in this graph that needs one
    // gets. It is what makes `hwupload` work at all — the filter takes no
    // argument that could name a device and reads `AVFilterContext::
    // hw_device_ctx` instead.
    //
    // **There is no such thing as a graph-wide device.** libavfilter has no
    // field for one; ffmpeg's own CLI walks the filters after the parse and
    // hands the device to each that declares `AVFILTER_FLAG_HWDEVICE`, and that
    // is what `attachDevice` below does. The reference is made here so that a
    // named device that does not exist refuses before anything is parsed.
    if (!settings_.filterHwDevice.empty()) {
        std::string why;
        hwDevice_ = hwDeviceRef(settings_.filterHwDevice, settings_.filterHwDeviceIndex, &why);
        if (!hwDevice_) return fail(why);
    }

    AVFilterInOut* inputs = nullptr;
    AVFilterInOut* outputs = nullptr;
    int rc = parseGraph(&inputs, &outputs);
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

    bool anyVideo = false;
    for (const auto& s : sinks_) if (!s->audio) anyVideo = true;
    if (!anyVideo) return fail("the filter graph has no picture coming out of it");

    rc = avfilter_graph_config(graph_, nullptr);
    if (rc < 0) return fail("the filter graph will not run: " + avErr(rc));

    choosePrimaries();
    // Nothing below is about a pad-fed stream: those are opened for whatever
    // size their own sink settled on, which is what `padWidth`/`padHeight` are
    // for. What is checked here is the *canvas*, which is the one picture the
    // render has an opinion about — and a graph that never said which pad is
    // the composite has no canvas to disagree with.
    if (!vprimary_) return true;

    // The graph decides its own output size, and the writer was opened for the
    // one in the settings. Caught here, where it can be said plainly, rather
    // than as a scaler quietly resizing every frame — unless the render asked
    // to follow the graph, in which case there is nothing to disagree with and
    // the answer is taken. Rounded down to even because yuv420p has no half
    // pixels; a graph that lands on an odd size gets a one-pixel resize on the
    // way into the canvas rather than an encoder that refuses.
    const int w = av_buffersink_get_w(vprimary_->ctx), h = av_buffersink_get_h(vprimary_->ctx);
    if (settings_.sizeFromGraph) {
        settings_.width = std::max(16, w & ~1);
        settings_.height = std::max(16, h & ~1);
    } else if (w != settings_.width || h != settings_.height) {
        return fail("the graph produces " + std::to_string(w) + "x" + std::to_string(h) +
                    " but the render is " + std::to_string(settings_.width) + "x" +
                    std::to_string(settings_.height));
    }

    const AVRational r = av_buffersink_get_frame_rate(vprimary_->ctx);
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
        // A phone clip that decoded on the card has to be turned round on the
        // card: `transpose` reads pixels and a `cuda` frame has none. The
        // hardware member of the family is tried first and only for a feed that
        // is actually on a device, so an ordinary render still gets the filter
        // ffmpeg's own autorotate would insert.
        const AVFilter* transpose = nullptr;
        if (feed->video->onDevice()) {
            const std::string named = "transpose_" +
                (settings_.filterHwDevice == "d3d11va" ? std::string("d3d11")
                                                       : settings_.filterHwDevice);
            transpose = avfilter_get_by_name(named.c_str());
            if (!transpose && quarters) {
                if (err)
                    *err = "[" + label + "] decodes on the card and needs turning the right "
                           "way up, and this build has no hardware transpose for " +
                           settings_.filterHwDevice +
                           " — decode it in software, or clear the rotation";
                return false;
            }
        }
        if (!transpose) transpose = avfilter_get_by_name("transpose");
        for (int i = 0; i < quarters; ++i) {
            AVFilterContext* t = nullptr;
            const std::string name = "rot_" + label + "_" + std::to_string(i);
            int rc = avfilter_graph_create_filter(&t, transpose, name.c_str(), "clock",
                                                  nullptr, graph_);
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
        // A pad fed pictures that are still on the card has to say which pool
        // they came out of *before* the graph is configured. Without it
        // libavfilter negotiates formats for a `cuda` frame it has never seen
        // and fails at the first link with a message about pixel formats and no
        // mention of hardware — which is the least helpful place to find out
        // that an input decoded somewhere the graph cannot read.
        if (AVBufferRef* pool = feed.video->hwFrames())
            par->hw_frames_ctx = av_buffer_ref(pool);
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
    // `av_buffersrc_parameters_set` takes its own reference to the pool, so the
    // one made above is ours to drop. Left in place it keeps a CUDA surface
    // pool alive for the life of the process.
    if (par->hw_frames_ctx) av_buffer_unref(&par->hw_frames_ctx);
    av_free(par);
    if (rc >= 0) rc = avfilter_init_dict(feed.src, nullptr);
    if (rc < 0) {
        if (err) *err = "cannot describe [" + feed.label + "] to the graph: " + avErr(rc);
        return false;
    }
    return true;
}

/// One sink per unconsumed output pad, however many there are.
///
/// This used to refuse the second output of a kind, which was the truth while a
/// render was one picture and one soundtrack: there was nowhere for a second pad
/// to go. A file is a list of streams now and `pad:<label>` is where it goes, so
/// what is left here is bookkeeping — a buffersink, its label, and the order the
/// parse handed them over in, which is the order `padLabels` reports and
/// therefore the order a refusal lists them in.
bool GraphSource::attachOutput(AVFilterInOut* out, std::string* err) {
    auto sink = std::make_unique<Sink>();
    sink->audio = typeOfOutput(out) == AVMEDIA_TYPE_AUDIO;
    sink->label = nameOf(out);
    sink->frame = av_frame_alloc();
    sink->down = av_frame_alloc();
    if (!sink->frame || !sink->down) { if (err) *err = "out of memory"; return false; }

    const char* kind = sink->audio ? "abuffersink" : "buffersink";
    // Numbered, because two sinks cannot share a name inside one graph and a
    // pad's own label is not always there to use — an unlabelled last pad is
    // the ordinary shape of every graph this application derived.
    const std::string name = std::string("out_") + (sink->audio ? "a" : "v") +
                             std::to_string(sinks_.size());
    int rc = avfilter_graph_create_filter(&sink->ctx, avfilter_get_by_name(kind), name.c_str(),
                                          nullptr, nullptr, graph_);
    if (rc >= 0) rc = avfilter_link(out->filter_ctx, out->pad_idx, sink->ctx, 0);
    if (rc < 0) {
        if (err) *err = std::string("cannot take the ") + (sink->audio ? "sound" : "picture") +
                        " out of the graph: " + avErr(rc);
        return false;
    }
    // Nothing is asked of the sink's format: the graph settles on its own, and
    // what comes out is converted here, where the colour tags of the frame are
    // to hand. Constraining it would be the same conversion done by a filter
    // libavfilter inserts, with the tags guessed instead of read.
    sinks_.push_back(std::move(sink));
    return true;
}

/// Which pad is the composite, and which is the mix.
///
/// **One pad of a kind is that kind's answer whatever it is labelled.** That is
/// today's behaviour written down: every graph this application has ever
/// rendered ends in one picture pad, sometimes called `vout` and sometimes
/// called nothing at all, and it is the canvas either way. Making the name
/// decide would refuse every spec in the suite.
///
/// With several, the name is the only thing that can decide, and the name is the
/// one the derivation has always used. A graph with several and no `vout` is not
/// an error here — a render whose every video stream comes from a named pad is a
/// perfectly good render — so what happens is that there is no composite, and
/// the job refuses only if something asked for one.
void GraphSource::choosePrimaries() {
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
        // The composite and the mix are read whether or not anybody named them.
        if (slot) slot->mapped = true;
    }
}

const GraphSource::Sink* GraphSource::sinkFor(const std::string& label) const {
    if (label.empty()) return nullptr;
    for (const auto& s : sinks_) if (s->label == label) return s.get();
    return nullptr;
}

GraphSource::Sink* GraphSource::sinkFor(const std::string& label) {
    return const_cast<Sink*>(static_cast<const GraphSource*>(this)->sinkFor(label));
}

bool GraphSource::padIsAudio(const std::string& label) const {
    const Sink* s = sinkFor(label);
    return s && s->audio;
}

int GraphSource::padWidth(const std::string& label) const {
    const Sink* s = sinkFor(label);
    return s && !s->audio ? av_buffersink_get_w(s->ctx) : 0;
}

int GraphSource::padHeight(const std::string& label) const {
    const Sink* s = sinkFor(label);
    return s && !s->audio ? av_buffersink_get_h(s->ctx) : 0;
}

std::vector<std::string> GraphSource::padLabels(bool audio) const {
    std::vector<std::string> out;
    for (const auto& s : sinks_) if (s->audio == audio) out.push_back(s->label);
    return out;
}

void GraphSource::readPads(const std::vector<std::string>& labels) {
    for (const auto& label : labels)
        if (Sink* s = sinkFor(label)) s->mapped = true;
}

bool GraphSource::exhausted(double) const {
    if (vprimary_) return vprimary_->ended;
    for (const auto& s : sinks_) if (!s->audio && !s->ended) return false;
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

int GraphSource::pull(Sink& sink, AVFrame* into) {
    for (;;) {
        const int rc = av_buffersink_get_frame(sink.ctx, into);
        if (rc != AVERROR(EAGAIN)) {
            // Whatever the graph measured about this frame, on its way past.
            //
            // A whole family of filters — cropdetect, blackdetect,
            // silencedetect, ebur128, signalstats, psnr, ssim — answers a
            // question rather than changing a picture, and libavfilter's way of
            // answering is to hang the numbers on the frame. Harvested here, in
            // the one place every sink is read from, so that adding a measuring
            // filter to a graph is all anybody has to do to see its numbers.
            // Costs a null check per frame when there are none, which is every
            // render that is not measuring anything.
            if (rc >= 0 && into->metadata)
                reportFrameMetadata(sink.audio, frameTime(sink.ctx, into), into->metadata);
            return rc;
        }
        if (!pushSome()) return AVERROR_EOF;
    }
}

/// One frame out of every picture sink, and the sound nobody wants thrown away.
///
/// **The pads move together or not at all.** They come out of one graph, and a
/// pad pulled at a different moment from the canvas is a stream whose frames are
/// out of step with the picture they were made beside — which is invisible in
/// the file and obvious the moment two streams of it are played together.
///
/// A sink nobody reads is still emptied, and that is not tidiness: libavfilter
/// holds every frame it has pushed at a sink until somebody takes it, so a pad
/// left alone grows with the length of the render. What differs between the two
/// kinds is *how*: a picture pad is pulled like any other, because the graph has
/// to be driven forward anyway and this is where that happens; a sound pad is
/// taken only as far as what is already there, because driving the inputs on
/// behalf of a stream nobody is writing would read a whole file to throw it away.
void GraphSource::tick() {
    for (auto& sp : sinks_) {
        Sink& s = *sp;
        if (s.audio) {
            if (s.mapped || s.ended) continue;
            for (;;) {
                const int rc = av_buffersink_get_frame(s.ctx, s.frame);
                if (rc < 0) {
                    if (rc != AVERROR(EAGAIN)) s.ended = true;
                    break;
                }
                if (s.frame->metadata)
                    reportFrameMetadata(true, frameTime(s.ctx, s.frame), s.frame->metadata);
                av_frame_unref(s.frame);
            }
            continue;
        }
        // Nothing is converted here. A pad nobody asks for costs a pull and no
        // pixels, which is what makes draining an unread sink cheap enough to
        // be unconditional.
        s.converted = false;
        if (s.ended) continue;
        av_frame_unref(s.frame);
        // The graph has run out before the render has. Black, not a freeze on
        // the last picture: that is what the track stack shows when nothing
        // covers the playhead, and a still frame would read as a stall.
        if (pull(s, s.frame) < 0) s.ended = true;
    }
}

bool GraphSource::convertInto(Sink& s, Rgba& dst, SwsContext** scaler) {
    if (s.ended || !s.frame->data[0]) return false;

    // The graph kept its pictures on the card and the *compositor's* question is
    // being asked of it — which is what happens when a `_cuda` chain is
    // previewed on a node, or when the encoder at the far end is a software one.
    // Legal, and the readback is exactly the cost this whole path exists to
    // avoid; a render that wanted to avoid it takes `nativeAt` instead.
    if (s.frame->hw_frames_ctx) {
        std::string why;
        if (!downloadFrame(&s.frame, &s.down, &why)) {
            s.ended = true;
            reportNote(AV_LOG_ERROR, "graph", why);
            return false;
        }
    }
    const AVFrame* f = s.frame;

    // The copy is a fast path for a frame that is already the picture asked
    // for, and the size has to be part of that test rather than assumed from
    // it. `build()` refuses a graph whose size disagrees with the render — but
    // only when the render is not following the graph, and under
    // `sizeFromGraph` there is a sixteen-pixel floor, so a last pad smaller
    // than that produces a canvas legitimately bigger than the frame. Sized
    // from the canvas, the copy then read rows the frame does not have. A node
    // preview of anything tiny is two clicks away from it. Anything that does
    // not match goes through the scaler below, which is where a resize belonged
    // anyway.
    if (f->format == AV_PIX_FMT_RGBA && f->width == dst.width && f->height == dst.height) {
        const uint8_t* src = f->data[0];
        uint8_t* out = dst.data.data();
        for (int y = 0; y < dst.height; ++y) {
            std::memcpy(out, src, static_cast<size_t>(dst.width) * 4);
            src += f->linesize[0];
            out += dst.stride;
        }
        return true;
    }

    // A graph that ends somewhere other than RGBA still renders; it just pays
    // for a conversion the writer will partly undo. Done with the frame's own
    // tags rather than swscale's default, which is BT.601 whatever the picture
    // says it is.
    const auto fmt = static_cast<AVPixelFormat>(f->format);
    *scaler = sws_getCachedContext(*scaler, f->width, f->height, fmt, dst.width, dst.height,
                                   AV_PIX_FMT_RGBA, scalerFlag(settings_.scaler), nullptr,
                                   nullptr, nullptr);
    if (!*scaler) return false;
    setColorspace(*scaler, swsSpaceFor(f->colorspace, f->height),
                  f->color_range == AVCOL_RANGE_JPEG ? 1 : 0, SWS_CS_ITU709, 1);
    uint8_t* out[4] = {dst.data.data(), nullptr, nullptr, nullptr};
    int stride[4] = {dst.stride, 0, 0, 0};
    return sws_scale(*scaler, f->data, f->linesize, 0, f->height, out, stride) > 0;
}

const Rgba& GraphSource::canvasAt(double) {
    tick();
    canvas_.resize(settings_.width, settings_.height);

    const auto black = [this]() -> const Rgba& {
        std::fill(canvas_.data.begin(), canvas_.data.end(), uint8_t{0});
        return canvas_;
    };
    // No pad said it was the canvas, which is a graph whose every picture goes
    // to a named stream. There is still a canvas — the range is the range and
    // the writer may still have a composite-fed stream on some other path — and
    // black is what it honestly contains.
    if (!vprimary_) return black();
    if (!convertInto(*vprimary_, canvas_, &toCanvas_)) return black();
    return canvas_;
}

const Rgba* GraphSource::padPicture(Sink& s) {
    // The pad's own size, which is the size the stream fed from it was opened
    // for: `padWidth`/`padHeight` are asked of this very sink, so the writer's
    // scaler has nothing to do beyond the colour.
    s.rgba.resize(std::max(1, av_buffersink_get_w(s.ctx)),
                  std::max(1, av_buffersink_get_h(s.ctx)));
    if (s.converted) return &s.rgba;
    s.converted = true;
    if (!convertInto(s, s.rgba, &s.toRgba))
        std::fill(s.rgba.data.begin(), s.rgba.data.end(), uint8_t{0});
    return &s.rgba;
}

const Rgba* GraphSource::padAt(const std::string& label) {
    Sink* s = sinkFor(label);
    if (!s || s->audio) return nullptr;
    return padPicture(*s);
}

AVBufferRef* GraphSource::hwFrames() const {
    return vprimary_ ? av_buffersink_get_hw_frames_ctx(vprimary_->ctx) : nullptr;
}

const AVFrame* GraphSource::nativeAt(double) {
    if (!vprimary_) return nullptr;
    tick();
    // No black frame at the end of this path, deliberately. Black in the
    // encoder's format would have to be made in system memory and uploaded,
    // which is the readback this path exists to avoid — done once a frame
    // for however much of the range is left over. A render that keeps its
    // pictures on the card ends when its graph does, and README says so.
    return vprimary_->ended ? nullptr : vprimary_->frame;
}

// ── Sound ──────────────────────────────────────────────────────────────────

int GraphSource::available(const Sink& s) const {
    const int ch = std::max(1, settings_.audioChannels);
    return static_cast<int>((s.fifo.size() - s.head) / ch);
}

void GraphSource::takeSamples(Sink& s, const AVFrame* f) {
    const auto inFmt = static_cast<AVSampleFormat>(f->format);
    const int channels = std::max(1, settings_.audioChannels);
    if (!s.swr || inFmt != s.swrFmt || f->sample_rate != s.swrRate) {
        if (s.swr) swr_free(&s.swr);
        AVChannelLayout out{};
        av_channel_layout_default(&out, channels);
        const int rc = swr_alloc_set_opts2(&s.swr, &out, AV_SAMPLE_FMT_FLT,
                                           settings_.audioSampleRate, &f->ch_layout, inFmt,
                                           f->sample_rate, 0, nullptr);
        av_channel_layout_uninit(&out);
        if (rc < 0 || !s.swr || swr_init(s.swr) < 0) return;
        s.swrFmt = inFmt;
        s.swrRate = f->sample_rate;
    }

    const int64_t delay = swr_get_delay(s.swr, settings_.audioSampleRate);
    const int maxOut = static_cast<int>(av_rescale_rnd(
        delay + f->nb_samples, settings_.audioSampleRate, f->sample_rate, AV_ROUND_UP));
    if (maxOut <= 0) return;

    // Slack past the samples asked for — see kSwrSlack in export_frame.h.
    const size_t base = s.fifo.size();
    s.fifo.resize(base + static_cast<size_t>(maxOut) * channels + kSwrSlack);
    auto* dst = reinterpret_cast<uint8_t*>(s.fifo.data() + base);
    const int written = swr_convert(s.swr, &dst, maxOut,
                                    const_cast<const uint8_t**>(f->extended_data),
                                    f->nb_samples);
    s.fifo.resize(base + static_cast<size_t>(std::max(0, written)) * channels);
}

/// One sound pad's next `frames` samples, added into `dst`.
///
/// **The resampler and the fifo are the sink's**, which is the whole of what
/// having several sound pads costs: two streams read at the same moment are two
/// positions in two buffers, and one buffer between them would hand each of them
/// alternate blocks of the other's sound.
void GraphSource::fillAudio(Sink& s, float* dst, int frames) {
    const int channels = std::max(1, settings_.audioChannels);

    int done = 0;
    while (done < frames) {
        if (available(s) == 0) {
            if (s.ended) break;
            av_frame_unref(s.frame);
            if (pull(s, s.frame) < 0) { s.ended = true; break; }
            takeSamples(s, s.frame);
            continue;
        }
        const int n = std::min(frames - done, available(s));
        const float* src = s.fifo.data() + s.head;
        const int count = n * channels;
        for (int i = 0; i < count; ++i) dst[done * channels + i] += src[i];
        s.head += static_cast<size_t>(count);
        done += n;
        if (s.head >= 65536) {
            s.fifo.erase(s.fifo.begin(), s.fifo.begin() + static_cast<long>(s.head));
            s.head = 0;
        }
    }

    // The graph has already mixed; this only has to stay in range, which
    // several `amix` inputs summed with `normalize=0` need as much as the
    // compositor's own mixer does.
    const size_t total = static_cast<size_t>(frames) * channels;
    for (size_t i = 0; i < total; ++i)
        dst[i] = dst[i] < -1.0f ? -1.0f : (dst[i] > 1.0f ? 1.0f : dst[i]);
}

/// The rate and channel count are the settings' — the graph was configured for
/// them and the job asks with them — so the parameters that say so again are
/// not read. One place decides what the sound of a render is.
void GraphSource::mixInto(float* dst, double, int frames, int, int) {
    if (!aprimary_) return;
    fillAudio(*aprimary_, dst, frames);
}

bool GraphSource::padMixInto(const std::string& label, float* dst, double, int frames, int,
                             int) {
    Sink* s = sinkFor(label);
    if (!s || !s->audio) return false;
    fillAudio(*s, dst, frames);
    return true;
}

} // namespace ffmpegbro
