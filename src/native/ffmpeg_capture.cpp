// Recording a device. See ffmpeg_capture.h for why this is a second job rather
// than a flag on the render, and for what the filter graph in the middle of it
// is and is not.

#include "ffmpeg_capture.h"

#include "capture_graph.h"
#include "export_frame.h"
#include "export_writer.h"
#include "ffmpeg_job.h"
#include "ffmpeg_report.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include "util/log.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

/// One open device: its demuxer, the two decoders it might have, and the
/// converters into the currency the writer takes.
///
/// It is not a `SourceVideo` and a `SourceAudio` because those own a demuxer
/// each, and one device is one demuxer: `-f dshow -i "video=Camera:audio=Mic"`
/// is a single `-i` carrying both, and opening it twice would open the camera
/// twice — which on Windows is not a slow path, it is an error.
struct Device {
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

/// Open the device and settle everything that has to be known before the file
/// can be: the picture size, the rate, and whether there is any sound.
bool openDevice(Device& d, CaptureSettings& s, std::string* err) {
    if (!openInput(&d.fmt, s.source, err)) return false;

    d.videoStream = av_find_best_stream(d.fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    d.audioStream = av_find_best_stream(d.fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (d.videoStream < 0 && d.audioStream < 0) {
        *err = s.source.path + ": this device produced neither pictures nor sound";
        return false;
    }

    if (d.videoStream >= 0) {
        std::string why;
        if (!openDecoder(d.fmt, d.videoStream, &d.vdec, &why)) {
            *err = s.source.path + ": " + why;
            return false;
        }
        // The device's own picture is the output picture unless somebody said
        // otherwise. A capture is not composited — there is no canvas to fit
        // it into — so a size of this application's choosing would be a scale
        // nobody asked for on every frame. A filter graph *is* somebody saying
        // otherwise, and the composite pad's size wins once it is configured.
        if (s.output.width <= 0 || s.output.height <= 0) {
            s.output.width = d.vdec->width;
            s.output.height = d.vdec->height;
        }
        if (s.output.fps <= 0.0) {
            const AVRational r = av_guess_frame_rate(d.fmt, d.fmt->streams[d.videoStream],
                                                     nullptr);
            s.output.fps = r.num > 0 && r.den > 0 ? av_q2d(r) : 30.0;
        }
    } else {
        // Sound only. The writer still wants a canvas size and a rate for the
        // video stream it is not going to open; nothing reads them.
        if (s.output.width <= 0) s.output.width = 16;
        if (s.output.height <= 0) s.output.height = 16;
        if (s.output.fps <= 0.0) s.output.fps = 30.0;
    }
    // yuv420p has no half pixels, and an odd canvas fails at avcodec_open2
    // with an unhelpful message.
    s.output.width = std::max(16, s.output.width & ~1);
    s.output.height = std::max(16, s.output.height & ~1);

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

/// What this device can offer a filter graph. A list of one, because the next
/// thing this grows is a second input and nothing in `CaptureGraph` says "the
/// device".
std::vector<CaptureGraph::FeedSource> feedsOf(const Device& d) {
    CaptureGraph::FeedSource f;
    f.index = 0;
    f.hasVideo = d.vdec != nullptr;
    f.hasAudio = d.adec != nullptr;
    return {f};
}

/// One decoded picture as RGBA at the output size.
const Rgba* toCanvas(Device& d, Rgba& canvas, int w, int h) {
    const AVFrame* f = d.frame;
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
void runCapture(CaptureSettings s, std::shared_ptr<Device> dev) {
    job::Held slot;
    Device& d = *dev;

    const auto began = std::chrono::steady_clock::now();
    const auto secondsSince = [&began] {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count();
    };

    ExportStatus st = job::status();
    st.state = ExportStatus::State::Running;
    st.path = s.output.path;
    st.stage = "opening";
    job::publish(st);

    const auto refuse = [&](const std::string& why) {
        st.state = ExportStatus::State::Failed;
        st.error = why;
        st.elapsedSec = secondsSince();
        job::publish(st);
        LOG_ERROR("capture failed: %s", why.c_str());
        reportNote(AV_LOG_ERROR, "capture", why);
    };

    std::string err;

    // The graph, built here rather than where the recording was asked for, for
    // the reason the writer is: it is the thing that runs, and it is built where
    // it runs. Everything about it that could be refused was refused before this
    // thread existed — see `startCapture`.
    std::unique_ptr<CaptureGraph> graph;
    if (!s.output.filterGraph.empty()) {
        graph = std::make_unique<CaptureGraph>(s.output.filterGraph, s.output.audioSampleRate,
                                               s.output.audioChannels, s.output.scaler);
        if (!graph->open(feedsOf(d), &err)) { refuse(err); return; }
    }
    const int vFeed = graph ? graph->feedFor(0, false) : -1;
    const int aFeed = graph ? graph->feedFor(0, true) : -1;

    // Is a picture going to arrive at all? It decides what happens to sound that
    // turns up before one: dropped, because letting it in would put the whole
    // soundtrack ahead of the picture by however long the device took to wake up.
    // With a graph reading the device's picture there is always one — `open()`
    // refuses a graph that eats it and produces none.
    const bool expectsPicture = (graph && !graph->videoDirect()) ? true : d.videoStream >= 0;

    Writer writer;
    bool opened = false;
    std::vector<VidDest> vids;
    std::vector<AudDest> auds;
    AudDest* mixDest = nullptr;

    const int rate = s.output.audioSampleRate;
    const int channels = s.output.audioChannels;
    // Zero means until stopped. It is `-t` on the input, which is where a
    // command line puts it — and it is judged on *output* time, so a graph that
    // changes the rate still records the number of seconds that was asked for.
    const double limit = s.source.duration;

    double epoch = -1.0;        // the first picture's timestamp; the recording's zero
    bool stop = false;

    // **The file is opened for what the graph turned out to produce.** A pad's
    // size is not knowable until libavfilter has configured the graph, and the
    // graph is not configured until the device has handed over a frame — so with
    // a graph this runs on the first frame rather than up front, which is the
    // one ordering difference between a recording and a render on this path.
    const auto openWriter = [&](std::string* why) {
        if (graph) {
            if (const int w = graph->compositeWidth()) {
                s.output.width = std::max(16, w & ~1);
                s.output.height = std::max(16, graph->compositeHeight() & ~1);
            }
            if (const double r = graph->compositeRate(); r > 0.0) s.output.fps = r;
            if (limit > 0.0)
                st.framesTotal = std::max<int64_t>(1, std::llround(limit * s.output.fps));
        }

        const bool wantAudio = graph ? graph->hasMix() : d.adec != nullptr;
        std::vector<ExportStream> resolved = outputStreams(s.output, wantAudio);
        std::vector<std::string> reads;
        // The same refusals a render makes about `pad:`, in the same words: the
        // moment differs because a recording learns its pad sizes late, and the
        // answers must not.
        if (!resolvePads(s.output, graph.get(), resolved, &reads, why)) return false;
        if (graph) {
            graph->readPads(reads);
            if (!reads.empty()) resolved = outputStreams(s.output, wantAudio);
        }
        if (!writer.open(s.output, wantAudio, why)) return false;
        opened = true;

        // The composite first, so that `vids.front()` is the picture the
        // recording's frame count and its `-t` are about.
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
    };

    if (!graph && !openWriter(&err)) { refuse(err); return; }
    st.stage = "recording";
    job::publish(st);

    const auto writeOne = [&](VidDest& v, const Rgba& pic, int64_t n) {
        const bool ok = v.composite ? writer.writeVideo(pic, n, &err)
                                    : writer.writeVideoTo(v.desc, pic, n, &err);
        if (!ok) {
            st.state = ExportStatus::State::Failed;
            st.error = err;
            stop = true;
        }
        return ok;
    };

    /// Where this picture belongs, and everything owed before it. False when
    /// the recording is over — the limit was reached, or a write failed.
    const auto place = [&](VidDest& v, double at, const Rgba& pic) {
        // The recording's zero is the first picture. Sound that arrived before
        // it is sound from before the recording had anything to show.
        if (epoch < 0.0) epoch = at < 0.0 ? 0.0 : at;
        const double rel = at < 0.0 ? double(v.next) / s.output.fps : at - epoch;
        if (limit > 0.0 && rel >= limit) { stop = true; return false; }

        // Rounded to an output frame, so a device that runs a little fast or a
        // little slow still writes a file whose clock is the wall clock.
        const int64_t index = std::max<int64_t>(v.next, std::llround(rel * s.output.fps));
        // A stall holds the last picture rather than leaving a hole. Cheap
        // because the gap is rare and one frame long when it is not; a gap left
        // open would make the muxer's timestamps jump, which several players
        // read as a corrupt file.
        while (v.haveHeld && v.next < index) {
            if (!writeOne(v, v.held, v.next)) return false;
            v.next++;
        }
        if (!writeOne(v, pic, v.next)) return false;
        v.held = pic;
        v.haveHeld = true;
        v.next++;
        if (&v == vids.data()) st.framesDone = v.next;
        return true;
    };

    const auto writeSound = [&](AudDest& a, double at, const float* samples, int frames) {
        // Sound before the first picture is dropped to the sample: a whole frame
        // of it is twenty milliseconds, which is audible as a lip-sync error and
        // is exactly the kind of thing nobody finds until the recording is the
        // only copy.
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
    };

    /// One frame off one pad of the graph, to every destination reading it. A
    /// pad read both as the composite and by name is one sink written twice,
    /// which for a picture is simply the same picture in two streams.
    const auto emit = [&](const CaptureGraph::Taken& tk) {
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
    };

    Rgba canvas;
    std::vector<float> samples;

    const auto stamp = [&](int stream, const AVFrame* f) {
        const int64_t ts = f->best_effort_timestamp != AV_NOPTS_VALUE
                               ? f->best_effort_timestamp : f->pts;
        if (ts == AV_NOPTS_VALUE) return -1.0;
        return ts * av_q2d(d.fmt->streams[stream]->time_base);
    };

    while (!stop) {
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

        while (!stop) {
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
                    stop = true;
                    break;
                }
                if (graph->ready() && !opened && !openWriter(&err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    stop = true;
                    break;
                }
                // `emit` refuses when the recording is over, and it has already
                // said which of the two reasons it was.
                if (opened && !graph->drain(emit, &err)) stop = true;
                continue;
            }

            // Straight to the writer: this stream of the device is one the graph
            // does not read, which is exactly what it was before there was a
            // graph at all. Nothing is written before the file exists — with a
            // graph that is the frame or two it takes to configure, and the
            // recording's zero is the first picture that *was* written.
            if (!opened) continue;
            const double t = stamp(d.pkt->stream_index, d.frame);

            if (isVideo) {
                if (vids.empty()) continue;
                const Rgba* pic = toCanvas(d, canvas, s.output.width, s.output.height);
                if (!pic) continue;
                if (!place(vids.front(), t, *pic)) break;
            } else if (mixDest) {
                const int have = d.frame->nb_samples;
                if (have <= 0) continue;
                const int out = static_cast<int>(
                    av_rescale_rnd(swr_get_delay(d.swr, d.adec->sample_rate) + have,
                                   rate, d.adec->sample_rate, AV_ROUND_UP));
                // Slack past the samples asked for — see kSwrSlack in
                // export_frame.h. `assign` on a fresh vector allocates exactly
                // what it was told, so this one had no slack at all on its
                // first call: of the four resamplers in this binary it was the
                // one with nothing behind it to absorb the overrun.
                samples.assign(static_cast<size_t>(out) * channels + kSwrSlack, 0.0f);
                uint8_t* dst = reinterpret_cast<uint8_t*>(samples.data());
                // `extended_data` rather than `data` for the reason
                // `Writer::drainFifo` uses it: a planar format has one pointer
                // per channel and `AVFrame::data` is eight of them, so a device
                // handing back more than 7.1 planar would be read past the end
                // of the array.
                const int got = swr_convert(
                    d.swr, &dst, out,
                    const_cast<const uint8_t**>(d.frame->extended_data), have);
                if (got <= 0) continue;
                if (!writeSound(*mixDest, t, samples.data(), got)) break;
            }
        }

        st.elapsedSec = secondsSince();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        if (opened) {
            st.bytesWritten = writer.bytesSoFar();
            st.piecesWritten = writer.piecesWritten();
        }
        // **No progress fraction.** There is no total to divide by, and a bar
        // creeping towards an end nobody chose is worse than no bar: what a
        // recording can say honestly is how long it has been going and how big
        // it has got, and both of those are facts.
        if (limit > 0.0) {
            st.framesTotal = std::max<int64_t>(1, std::llround(limit * s.output.fps));
            st.progress = std::min(1.0, double(st.framesDone) / double(st.framesTotal));
        }
        job::publish(st);
    }

    // Whatever the filters were still holding. A recording stopped by hand keeps
    // it; one that reached its `-t` does not, because `place` refuses past the
    // limit and that refusal ends the drain.
    if (graph && opened && st.state == ExportStatus::State::Running) {
        graph->endAll();
        graph->drain(emit, &err);
    }
    // A graph builds from the first frame, so a device that never handed one
    // over leaves nothing opened and nothing written. Said rather than reported
    // as a clean recording of nothing.
    if (!opened && st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Failed;
        st.error = "the device produced nothing for the filter graph to run on";
    }

    const bool failed = st.state == ExportStatus::State::Failed;
    if (opened) {
        if (!failed) { st.stage = "finishing"; job::publish(st); }

        // The trailer goes down whatever happened, exactly as it does for a
        // stopped render — and it matters more here. A render that lost its
        // index has lost a file that can be made again; a recording that lost
        // its index has lost the only copy of something that happened once.
        std::string finishErr;
        if (!writer.finish(&finishErr)) {
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
        st.bytesWritten = writer.bytesSoFar();
        st.piecesWritten = writer.piecesWritten();
    }

    // **Stopping a recording is how a recording ends.** It is not a
    // cancellation: nothing was abandoned and nothing was lost, and the length
    // was the open question that pressing stop answered. Reporting Cancelled
    // would make every successful recording look like a mistake, and would
    // make the one thing worth distinguishing — a recording that failed —
    // indistinguishable from the ordinary case.
    if (st.state == ExportStatus::State::Running) {
        st.state = ExportStatus::State::Done;
        st.stage = "done";
        st.progress = 1.0;
    }
    st.elapsedSec = secondsSince();

    job::release();
    job::publish(st);

    char said[512];
    if (st.state == ExportStatus::State::Done) {
        LOG_INFO("capture: wrote %s (%lld frames, %.1f s, %.1f MB)", s.output.path.c_str(),
                 static_cast<long long>(st.framesDone), st.elapsedSec,
                 st.bytesWritten / 1048576.0);
        std::snprintf(said, sizeof(said), "recorded %s — %lld frames in %.1f s, %.1f MB",
                      s.output.path.c_str(), static_cast<long long>(st.framesDone),
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
    if (s.source.path.empty()) {
        if (error) *error = "no device to record from";
        return false;
    }
    if (s.output.path.empty()) {
        if (error) *error = "no output file";
        return false;
    }
    // **A capture's graph is fed by the device and by nothing else.** A
    // `filterInputs` list says which *file* feeds which pad, which is the
    // render's question: a device cannot be cut from, so a file beside it on the
    // same graph would be an input with a window on one side and a camera on the
    // other. It is a later chunk's, and half-supporting it here would be a door
    // that opens onto the thing the device model says cannot be done.
    if (!s.output.filterInputs.empty()) {
        if (error)
            *error = "a recording's filter graph is fed by the device — [0:v] and [0:a] — "
                     "and cannot be given input files of its own";
        return false;
    }

    const uint64_t number = job::claim(s.output.path, error);
    if (!number) return false;
    if (jobNumber) *jobNumber = number;

    // Opened before the thread exists, so "there is no camera called that"
    // arrives as a refusal from this call rather than as a job that starts and
    // fails a moment later with the name that was wrong already off the screen.
    auto dev = std::make_shared<Device>();
    std::string why;
    bool ok = openDevice(*dev, s, &why);
    // And the graph is parsed here for the same reason, on a throwaway object:
    // a filter this build has not got, a pad the device cannot feed and a chain
    // that wants a graphics card are all things the person who typed the graph
    // should be told about while it is still on the screen. What *runs* is built
    // on the job thread, because that is where the writer is built too — this
    // one is parsed, read and dropped.
    if (ok && !s.output.filterGraph.empty()) {
        CaptureGraph probe(s.output.filterGraph, s.output.audioSampleRate,
                           s.output.audioChannels, s.output.scaler);
        ok = probe.open(feedsOf(*dev), &why);
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
        // `-t` on the device there *is* an end, and then it is a real total and
        // the percentage means something. A graph that changes the rate makes
        // this an estimate until the graph is configured, which is where it is
        // said again.
        ExportStatus st = job::status();
        st.openEnded = s.source.duration <= 0.0;
        st.framesTotal = st.openEnded
            ? 0 : std::max<int64_t>(1, std::llround(s.source.duration * s.output.fps));
        st.stage = "starting";
        job::publish(st);
    }

    job::run([s, dev] { runCapture(s, dev); });
    return true;
}

void stopCapture() { job::stop(); }

} // namespace ffmpegbro
