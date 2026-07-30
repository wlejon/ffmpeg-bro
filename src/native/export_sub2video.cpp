// Cues painted into pictures. See export_sub2video.h for why this exists at all
// — libavfilter has no subtitle input, and this is ffmpeg's own sub2video.

#include "export_sub2video.h"

#include "util/log.h"

extern "C" {
#include <libavutil/imgutils.h>
}

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ffmpegbro {
namespace {

/// The size a cue's coordinates are against.
///
/// `sub2video_prepare`'s rule, written out: the subtitle codec's own dimensions
/// where the container recorded them, the largest video stream of the same file
/// where it did not, and 720×576 where there is neither — which is a PAL frame,
/// and is libavformat's own fallback rather than a number chosen here.
///
/// **Not the render's output size**, which was the obvious alternative and is
/// wrong twice over: a rect at (160, 270) means the lower third of the picture it
/// was authored for and the middle of a 4K one, and the printed command — which
/// says nothing about a canvas — would then describe a different picture from the
/// render. Size is a fact about the input, and this is where the input says it.
void canvasFor(AVFormatContext* fmt, int stream, int* w, int* h) {
    const AVCodecParameters* par = fmt->streams[stream]->codecpar;
    if (par->width > 0 && par->height > 0) {
        *w = par->width;
        *h = par->height;
        return;
    }
    int bw = 0, bh = 0;
    for (unsigned i = 0; i < fmt->nb_streams; ++i) {
        const AVCodecParameters* p = fmt->streams[i]->codecpar;
        if (p->codec_type != AVMEDIA_TYPE_VIDEO) continue;
        bw = std::max(bw, p->width);
        bh = std::max(bh, p->height);
    }
    *w = bw > 0 ? bw : 720;
    *h = bh > 0 ? bh : 576;
}

} // namespace

SubtitleSource::~SubtitleSource() { close(); }

void SubtitleSource::close() {
    if (cur_) av_frame_free(&cur_);
    if (held_) av_frame_free(&held_);
    if (pkt_) av_packet_free(&pkt_);
    if (dec_) avcodec_free_context(&dec_);
    if (fmt_) avformat_close_input(&fmt_);
}

bool SubtitleSource::open(const MediaInput& in, std::string* err) {
    in_ = in;
    if (!openInput(&fmt_, in, err)) return false;

    stream_ = av_find_best_stream(fmt_, AVMEDIA_TYPE_SUBTITLE, -1, -1, nullptr, 0);
    if (stream_ < 0) {
        if (err) *err = in.path + " has no subtitle stream, so there are no cues to draw";
        return false;
    }
    AVStream* st = fmt_->streams[stream_];

    // **Refused here, by name.** Text cues are characters and drawing characters
    // is libass's job — the `subtitles` filter — so a text track wired to a
    // picture pad is a mistake with a right answer rather than something to
    // approximate. ffmpeg's own sub2video takes this track and paints nothing
    // out of it, one warning per cue, which is a render that succeeds and has no
    // subtitles in it.
    const AVCodecDescriptor* d = avcodec_descriptor_get(st->codecpar->codec_id);
    if (d && (d->props & AV_CODEC_PROP_TEXT_SUB)) {
        if (err)
            *err = std::string("the subtitle pad of ") + in.path + " is " + d->name +
                   ", which is characters rather than pictures of them — a graph draws cues by "
                   "painting the pictures a bitmap track carries, so a text track goes through "
                   "a subtitles filter (libass) instead";
        return false;
    }

    canvasFor(fmt_, stream_, &width_, &height_);
    // The same epoch `SourceVideo` puts its frames on: the input's own zero,
    // after its `-ss` and `-itsoffset`. The pictures these are overlaid onto are
    // on that clock and `framesync` compares the two, so a second epoch here
    // would draw every cue at the wrong moment by however far the container's
    // start is from zero.
    epoch_ = inputEpoch(in, fmt_->start_time != AV_NOPTS_VALUE
                                ? fmt_->start_time / double(AV_TIME_BASE) : 0.0);
    limit_ = inputLimit(in);

    if (!openDecoder(&dec_, st->codecpar, st->time_base, in, false, err)) return false;
    pkt_ = av_packet_alloc();
    cur_ = av_frame_alloc();
    held_ = av_frame_alloc();
    if (!pkt_ || !cur_ || !held_) {
        if (err) *err = "out of memory";
        return false;
    }

    // Every other stream discarded, so a two-hour film's pictures are not handed
    // back to be thrown away one at a time — the same line every subtitle walk
    // in this binary has.
    for (unsigned i = 0; i < fmt_->nb_streams; ++i)
        fmt_->streams[i]->discard = (static_cast<int>(i) == stream_) ? AVDISCARD_DEFAULT
                                                                    : AVDISCARD_ALL;
    return true;
}

void SubtitleSource::seekTo(double t) {
    if (!fmt_ || stream_ < 0) return;
    av_seek_frame(fmt_, stream_,
                  inputSeekTarget(fmt_->streams[stream_]->time_base, in_, std::max(0.0, t)),
                  AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(dec_);
    haveHeld_ = clearPending_ = false;
    ended_ = false;
}

bool SubtitleSource::blank(AVFrame* f, double at) {
    av_frame_unref(f);
    f->format = AV_PIX_FMT_RGB32;
    f->width = width_;
    f->height = height_;
    if (av_frame_get_buffer(f, 0) < 0) return false;
    // Zero is transparent black in RGB32, which is what "nothing on screen"
    // means to an `overlay`: alpha 0 everywhere leaves the picture beneath it
    // exactly as it was.
    for (int y = 0; y < height_; ++y)
        std::memset(f->data[0] + static_cast<ptrdiff_t>(y) * f->linesize[0], 0,
                    static_cast<size_t>(width_) * 4);
    f->pts = static_cast<int64_t>(std::llround(std::max(0.0, at) * AV_TIME_BASE));
    return true;
}

void SubtitleSource::paintRect(AVFrame* f, const AVSubtitleRect* r) {
    if (!r || r->type != SUBTITLE_BITMAP || !r->data[0] || !r->data[1]) return;
    // Clipped rather than dropped, and said once rather than per cue: a rect
    // reaching past the canvas is a file whose subtitle dimensions and video
    // dimensions disagree, which is a fact about the file and not a reason to
    // draw none of it.
    const int x0 = std::max(0, r->x), y0 = std::max(0, r->y);
    const int x1 = std::min(width_, r->x + r->w), y1 = std::min(height_, r->y + r->h);
    if ((r->x < 0 || r->y < 0 || r->x + r->w > width_ || r->y + r->h > height_) &&
        !warnedOutside_) {
        warnedOutside_ = true;
        LOG_WARN("sub2video: a cue at (%d,%d) %dx%d reaches past the %dx%d canvas; clipped",
                 r->x, r->y, r->w, r->h, width_, height_);
    }
    if (x1 <= x0 || y1 <= y0) return;

    const uint32_t* pal = reinterpret_cast<const uint32_t*>(r->data[1]);
    for (int y = y0; y < y1; ++y) {
        const uint8_t* src = r->data[0] + static_cast<ptrdiff_t>(y - r->y) * r->linesize[0] +
                             (x0 - r->x);
        uint32_t* dst = reinterpret_cast<uint32_t*>(
            f->data[0] + static_cast<ptrdiff_t>(y) * f->linesize[0]) + x0;
        for (int x = x0; x < x1; ++x) *dst++ = pal[*src++];
    }
}

bool SubtitleSource::decodeAhead() {
    if (ended_ || !fmt_) return false;
    for (;;) {
        av_packet_unref(pkt_);
        const int rc = av_read_frame(fmt_, pkt_);
        if (rc < 0) { ended_ = true; return false; }
        if (pkt_->stream_index != stream_) continue;

        AVSubtitle sub{};
        int got = 0;
        if (avcodec_decode_subtitle2(dec_, &sub, &got, pkt_) < 0) {
            // One unreadable cue is not a reason to lose the rest — the same
            // treatment the render's other two subtitle paths give it.
            LOG_WARN("sub2video: a cue would not decode; keeping the rest");
            continue;
        }
        if (!got) continue;

        // `sub.pts` is `AV_TIME_BASE_Q` and the display times are milliseconds
        // relative to it, which is libavcodec's arrangement rather than one
        // chosen here. This is where a `dvdsub` cue's *end* comes from: the
        // packet often carries no duration and the stop-display command inside
        // the payload does.
        const double base =
            (sub.pts != AV_NOPTS_VALUE ? sub.pts / double(AV_TIME_BASE) : 0.0) - epoch_;
        heldStart_ = base + sub.start_display_time / 1000.0;
        heldEnd_ = sub.end_display_time > sub.start_display_time
                       ? base + sub.end_display_time / 1000.0
                       : HUGE_VAL;
        if (heldEnd_ == HUGE_VAL && pkt_->duration > 0)
            heldEnd_ = heldStart_ +
                       pkt_->duration * av_q2d(fmt_->streams[stream_]->time_base);

        const bool ok = blank(held_, heldStart_);
        if (ok)
            for (unsigned i = 0; i < sub.num_rects; ++i) paintRect(held_, sub.rects[i]);
        avsubtitle_free(&sub);
        if (!ok) { ended_ = true; return false; }

        // Past the input's `-t`, which ends the feed for the reason it ends
        // `SourceVideo`'s: a window only one render path honoured would mean the
        // two were rendering different inputs.
        if (limit_ > 0.0 && heldStart_ >= limit_) { ended_ = true; return false; }
        haveHeld_ = true;
        return true;
    }
}

const AVFrame* SubtitleSource::next() {
    // The frame at zero: before the first cue there is nothing on the screen,
    // and `framesync` needs a frame at or before the first picture it syncs
    // against or the overlay has nothing to draw for the start of the render.
    if (!primed_) {
        primed_ = true;
        return blank(cur_, 0.0) ? cur_ : nullptr;
    }

    if (!haveHeld_) decodeAhead();

    // The cue on screen has expired and the next one does not replace it. This
    // is the frame that everybody forgets: without it a graph goes on drawing
    // the last cue it was given for the rest of the render.
    if (clearPending_ && clearAt_ != HUGE_VAL &&
        (!haveHeld_ || heldStart_ > clearAt_ + 1e-6)) {
        clearPending_ = false;
        return blank(cur_, clearAt_) ? cur_ : nullptr;
    }

    if (!haveHeld_) return nullptr;
    // The painted frame becomes the current one and the old current frame
    // becomes the scratch the next cue is painted into — so the reference the
    // graph took a moment ago is never written over.
    std::swap(cur_, held_);
    haveHeld_ = false;
    clearAt_ = heldEnd_;
    clearPending_ = true;
    ++painted_;
    return cur_;
}

} // namespace ffmpegbro
