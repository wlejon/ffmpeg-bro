// Recording live inputs. See ffmpeg_capture.h for why this is a second job
// rather than a flag on the render, for what the filter graph in the middle of
// it is and is not, and for the two clocks a session can run on.

#include "ffmpeg_capture.h"
#include "capture_internal.h"

#include "ffmpeg_job.h"
#include "ffmpeg_report.h"

extern "C" {
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
#include <libavutil/rational.h>
#include <libavutil/samplefmt.h>
}

#include "util/log.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace ffmpegbro {
namespace capture_detail {

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

namespace {

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

} // namespace

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

} // namespace capture_detail

bool startCapture(const CaptureSettings& settings, std::string* error,
                  uint64_t* jobNumber) {
    using namespace capture_detail;
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

} // namespace ffmpegbro
