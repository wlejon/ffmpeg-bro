// Recording a device. See ffmpeg_capture.h for why this is a second job
// rather than a flag on the render.

#include "ffmpeg_capture.h"

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
        // nobody asked for on every frame.
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

/// The whole recording, as a read loop.
///
/// It is not a walk over output frames the way `runExport` is, and it cannot
/// be: the device decides when a frame exists. What this does per frame is
/// place it — turn the device's own timestamp into an output frame number — so
/// that what comes out is constant frame rate whatever the device did, which
/// is what every editor wants and what the writer is built for.
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

    const bool wantAudio = d.adec != nullptr;
    Writer writer;
    std::string err;
    if (!writer.open(s.output, wantAudio, &err)) {
        st.state = ExportStatus::State::Failed;
        st.error = err;
        st.elapsedSec = secondsSince();
        job::publish(st);
        LOG_ERROR("capture failed: %s", err.c_str());
        reportNote(AV_LOG_ERROR, "capture", err);
        return;
    }

    st.stage = "recording";
    job::publish(st);

    const double fps = s.output.fps;
    const int rate = s.output.audioSampleRate;
    const int channels = s.output.audioChannels;
    // Zero means until stopped. It is `-t` on the input, which is where a
    // command line puts it.
    const double limit = s.source.duration;

    Rgba canvas;
    // The last picture written, kept so that a stall in the device holds the
    // frame rather than leaving a gap the muxer has to invent something for.
    Rgba held;
    std::vector<float> samples;

    double epoch = -1.0;        // the first frame's timestamp; the recording's zero
    int64_t nextIndex = 0;      // the next output frame number owed
    int64_t audioWritten = 0;   // samples handed to the writer
    bool haveHeld = false;

    const auto stamp = [&](int stream, const AVFrame* f) {
        const int64_t ts = f->best_effort_timestamp != AV_NOPTS_VALUE
                               ? f->best_effort_timestamp : f->pts;
        if (ts == AV_NOPTS_VALUE) return -1.0;
        return ts * av_q2d(d.fmt->streams[stream]->time_base);
    };

    bool stop = false;
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
            const double t = stamp(d.pkt->stream_index, d.frame);

            if (isVideo) {
                // The recording's zero is the first *picture*, when there is
                // one. Sound that arrived before it is sound from before the
                // recording had anything to show, and letting it in would put
                // the whole soundtrack ahead of the picture by however long
                // the camera took to produce its first frame.
                if (epoch < 0.0) epoch = t < 0.0 ? 0.0 : t;
                const double at = t < 0.0 ? double(nextIndex) / fps : t - epoch;
                if (limit > 0.0 && at >= limit) { stop = true; break; }

                const Rgba* pic = toCanvas(d, canvas, s.output.width, s.output.height);
                if (!pic) continue;

                // Where this picture belongs. Rounded to an output frame, so a
                // device that runs a little fast or a little slow still writes
                // a file whose clock is the wall clock.
                int64_t index = std::max<int64_t>(nextIndex, std::llround(at * fps));
                // A stall holds the last picture rather than leaving a hole.
                // Cheap because the gap is rare and one frame long when it is
                // not; a gap left open would make the muxer's timestamps jump,
                // which several players read as a corrupt file.
                while (haveHeld && nextIndex < index) {
                    if (!writer.writeVideo(held, nextIndex, &err)) {
                        st.state = ExportStatus::State::Failed;
                        st.error = err;
                        stop = true;
                        break;
                    }
                    nextIndex++;
                }
                if (stop) break;
                if (!writer.writeVideo(*pic, nextIndex, &err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    stop = true;
                    break;
                }
                held = *pic;
                haveHeld = true;
                nextIndex++;
                st.framesDone = nextIndex;
            } else if (writer.hasAudio()) {
                // Sound before the first picture is dropped to the sample: a
                // whole frame of it is twenty milliseconds, which is audible
                // as a lip-sync error and is exactly the kind of thing nobody
                // finds until the recording is the only copy.
                const int have = d.frame->nb_samples;
                if (have <= 0) continue;
                const int out = static_cast<int>(
                    av_rescale_rnd(swr_get_delay(d.swr, d.adec->sample_rate) + have,
                                   rate, d.adec->sample_rate, AV_ROUND_UP));
                samples.assign(static_cast<size_t>(out) * channels, 0.0f);
                uint8_t* dst = reinterpret_cast<uint8_t*>(samples.data());
                const int got = swr_convert(d.swr, &dst, out,
                                            const_cast<const uint8_t**>(d.frame->data), have);
                if (got <= 0) continue;

                int skip = 0;
                if (epoch >= 0.0 && t >= 0.0 && t < epoch)
                    skip = std::min(got, static_cast<int>(std::llround((epoch - t) * rate)));
                else if (epoch < 0.0 && d.videoStream >= 0)
                    continue;   // no picture yet; this is sound from before the recording
                else if (epoch < 0.0)
                    epoch = t < 0.0 ? 0.0 : t;

                const int usable = got - skip;
                if (usable <= 0) continue;
                if (!writer.writeAudio(samples.data() + size_t(skip) * channels, usable, &err)) {
                    st.state = ExportStatus::State::Failed;
                    st.error = err;
                    stop = true;
                    break;
                }
                audioWritten += usable;
                if (d.videoStream < 0 && limit > 0.0 &&
                    double(audioWritten) / rate >= limit) {
                    stop = true;
                    break;
                }
            }
        }

        st.elapsedSec = secondsSince();
        st.encodeFps = st.elapsedSec > 0 ? st.framesDone / st.elapsedSec : 0;
        st.bytesWritten = writer.bytesSoFar();
        // **No progress fraction.** There is no total to divide by, and a bar
        // creeping towards an end nobody chose is worse than no bar: what a
        // recording can say honestly is how long it has been going and how big
        // it has got, and both of those are facts.
        if (limit > 0.0) {
            st.framesTotal = std::max<int64_t>(1, std::llround(limit * fps));
            st.progress = std::min(1.0, double(st.framesDone) / double(st.framesTotal));
        }
        job::publish(st);
    }

    const bool failed = st.state == ExportStatus::State::Failed;
    if (!failed) { st.stage = "finishing"; job::publish(st); }

    // The trailer goes down whatever happened, exactly as it does for a
    // stopped render — and it matters more here. A render that lost its index
    // has lost a file that can be made again; a recording that lost its index
    // has lost the only copy of something that happened once.
    std::string finishErr;
    if (!writer.finish(&finishErr)) {
        if (failed) {
            LOG_WARN("capture: %s (while finishing a failed recording)", finishErr.c_str());
            reportNote(AV_LOG_WARNING, "capture",
                       finishErr + " (while finishing a failed recording)");
        } else {
            st.state = ExportStatus::State::Failed;
            st.error = finishErr;
        }
    }
    st.bytesWritten = writer.bytesSoFar();

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

bool startCapture(const CaptureSettings& settings, std::string* error) {
    CaptureSettings s = settings;
    if (s.source.path.empty()) {
        if (error) *error = "no device to record from";
        return false;
    }
    if (s.output.path.empty()) {
        if (error) *error = "no output file";
        return false;
    }

    if (!job::claim(s.output.path, error)) return false;

    // Opened before the thread exists, so "there is no camera called that"
    // arrives as a refusal from this call rather than as a job that starts and
    // fails a moment later with the name that was wrong already off the screen.
    auto dev = std::make_shared<Device>();
    std::string why;
    if (!openDevice(*dev, s, &why)) {
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
        // the percentage means something.
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
