// Subtitle streams that are decoded and written again. See export_subtitle.h.

#include "export_subtitle.h"

#include "export_writer.h"

#include "util/log.h"

extern "C" {
#include <libavutil/mathematics.h>
}

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>

namespace ffmpegbro {

bool parseDecodeSource(const std::string& source, int* input, int* stream) {
    if (!isDecodeSource(source)) return false;
    const size_t a = source.find(':');
    const size_t b = source.find(':', a + 1);
    if (b == std::string::npos) return false;
    const std::string in = source.substr(a + 1, b - a - 1);
    const std::string st = source.substr(b + 1);
    if (in.empty() || st.empty()) return false;
    for (char c : in) if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    for (char c : st) if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    *input = std::atoi(in.c_str());
    *stream = std::atoi(st.c_str());
    return true;
}

/// Where this input's zero is, for a track of cues.
///
/// **Two clocks meet in this file and they were not the same one.** A cue
/// arrives carrying the container's raw presentation time; `Tap::from` and
/// `Tap::to` are the window somebody asked for, on the input's own clock, and
/// the seek is made in those terms. The comparison that decides whether a cue
/// is in the window was made between the two, so the zeros differed by exactly
/// `-ss` — a subtitle input trimmed three seconds in wrote every cue three
/// seconds late and dropped none of the ones that were no longer in the input.
/// With no window on an input the difference is zero, which is why every test
/// in the suite passed and why this reaches a person as "the subtitles are
/// late by however far I trimmed" rather than as anything failing.
///
/// **This is `SourceVideo`'s and `SourceAudio`'s epoch, deliberately**, and not
/// the `streamZero` a copied stream is measured from. Cues are written into the
/// same output the composite and the mix go into, so they have to be placed on
/// the clock those are placed on, which is `inputEpoch` over the *container's*
/// start. `streamZero` counts from a stream's own first packet, and that exists
/// to undo the reorder delay a decode timestamp begins before the container's
/// start_time — a correction for a clock this path is not on, since `sub.pts`
/// is a presentation time and cues do not reorder. In practice the two agree on
/// every subtitle track measurable here (an .srt reports no container start at
/// all, and mov_text and Matroska both put their stream's origin at zero); what
/// separates them is a container that genuinely starts late, which is mpegts,
/// where the picture is already being placed the way this places the cues.
double cueEpoch(AVFormatContext* fmt, const MediaInput& in) {
    return inputEpoch(in, fmt->start_time != AV_NOPTS_VALUE
                              ? fmt->start_time / double(AV_TIME_BASE) : 0.0);
}

SubtitleStreams::Tap::~Tap() {
    if (pkt) av_packet_free(&pkt);
    if (dec) avcodec_free_context(&dec);
    if (fmt) avformat_close_input(&fmt);
}

SubtitleStreams::~SubtitleStreams() = default;

bool SubtitleStreams::build(const ExportSettings& s,
                            const std::vector<ExportStream>& streams, std::string* err) {
    for (size_t i = 0; i < streams.size(); ++i) {
        const ExportStream& desc = streams[i];
        if (!isDecodeSource(desc.source)) continue;
        if (desc.kind != "subtitle") {
            // The seam is deliberately narrow. Video and audio are *composed*
            // here — the canvas and the mix — and a second route into them that
            // decoded one input's stream straight into an encoder would be a
            // second answer to what the output looks like. Nothing stops it
            // later; nothing pretends it works now.
            *err = "'" + desc.source + "' decodes an input stream, which this build does "
                   "for subtitles — a " + desc.kind + " stream comes from the composite, "
                   "the mix, or copy:<input>:<stream>";
            return false;
        }

        int index = -1, stream = -1;
        if (!parseDecodeSource(desc.source, &index, &stream)) {
            *err = "'" + desc.source + "' is not an input and a stream in it — "
                   "decode:<input>:<stream>";
            return false;
        }

        auto tap = std::make_unique<Tap>();
        tap->desc = i;
        tap->in = resolveInput(s, index, "");
        if (tap->in.path.empty()) {
            *err = "'" + desc.source + "' names input " + std::to_string(index) +
                   ", and this render has " + std::to_string(s.inputs.size()) + " of them";
            return false;
        }
        if (!openInput(&tap->fmt, tap->in, err)) return false;
        if (stream < 0 || static_cast<unsigned>(stream) >= tap->fmt->nb_streams) {
            *err = tap->in.path + " has " + std::to_string(tap->fmt->nb_streams) +
                   " streams, so there is no stream " + std::to_string(stream) + " to read";
            return false;
        }
        AVStream* st = tap->fmt->streams[stream];
        if (st->codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE) {
            const char* got = av_get_media_type_string(st->codecpar->codec_type);
            *err = "stream " + std::to_string(stream) + " of " + tap->in.path + " is " +
                   (got ? got : "not a subtitle stream") + ", and this row is a subtitle stream";
            return false;
        }

        // **Pictures of text are not text.** Refused here, by name, rather than
        // as whatever the encoder says when it is handed a bitmap rect: the two
        // families are both called subtitles and only libavcodec's own property
        // tells them apart.
        const AVCodecDescriptor* d = avcodec_descriptor_get(st->codecpar->codec_id);
        if (d && !(d->props & AV_CODEC_PROP_TEXT_SUB)) {
            *err = std::string("stream ") + std::to_string(stream) + " of " + tap->in.path +
                   " is " + d->name + ", which is pictures of text rather than text — it can "
                   "be copied into a container that holds it, or burned into the picture with "
                   "a subtitles filter, but it cannot be converted";
            return false;
        }

        if (!openDecoder(&tap->dec, st->codecpar, st->time_base, tap->in, false, err))
            return false;
        tap->pkt = av_packet_alloc();
        if (!tap->pkt) { *err = "out of memory"; return false; }

        tap->zero = cueEpoch(tap->fmt, tap->in);
        tap->from = std::max(0.0, desc.copyFrom);
        tap->to = desc.copyTo;
        const double limit = inputLimit(tap->in);
        if (limit > 0.0 && (tap->to <= 0.0 || tap->to > limit)) tap->to = limit;
        if (tap->to > tap->from) span_ = std::max(span_, tap->to - tap->from);

        // Everything but this stream discarded, so the demuxer does not hand
        // back every video packet of a two-hour file to have it thrown away one
        // at a time. A subtitle track is a few kilobytes in a gigabyte.
        for (unsigned k = 0; k < tap->fmt->nb_streams; ++k)
            tap->fmt->streams[k]->discard =
                k == static_cast<unsigned>(stream) ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
        tap->stream = stream;

        // The window's start, sought backward for the reason every seek in this
        // renderer is: landing before it only costs cues that are then dropped,
        // and landing after it drops cues the render wanted.
        if (tap->from > 0.0) {
            const int64_t target = inputSeekTarget(st->time_base, tap->in, tap->from);
            if (av_seek_frame(tap->fmt, stream, target, AVSEEK_FLAG_BACKWARD) < 0)
                LOG_WARN("subtitles: %s would not seek to %.3f s; reading from the start",
                         tap->in.path.c_str(), tap->from);
        }

        taps_.push_back(std::move(tap));
    }
    return true;
}

const AVCodecContext* SubtitleStreams::decoderFor(size_t desc) const {
    for (const auto& t : taps_) if (t->desc == desc) return t->dec;
    return nullptr;
}

bool SubtitleStreams::done() const {
    for (const auto& t : taps_) if (!t->finished) return false;
    return true;
}

bool SubtitleStreams::pumpTo(double until, Writer& w, std::string* err) {
    for (auto& t : taps_) {
        if (t->finished) continue;
        if (!pumpTap(*t, until, w, err)) return false;
    }
    double at = 0.0;
    for (const auto& t : taps_) at = std::max(at, t->at);
    position_ = at;
    return true;
}

bool SubtitleStreams::pumpTap(Tap& t, double until, Writer& w, std::string* err) {
    while (true) {
        if (until > 0.0 && t.at >= until) return true;

        const int rc = av_read_frame(t.fmt, t.pkt);
        if (rc == AVERROR_EOF) { t.finished = true; return true; }
        if (rc < 0) {
            // A read error part way through a subtitle track is worth the same
            // treatment a truncated file gets everywhere else here: stop this
            // stream, keep the render. What was written is a shorter set of
            // cues, which is legible; a failed render is not.
            LOG_WARN("subtitles: %s stopped being readable; keeping what was decoded",
                     t.in.path.c_str());
            t.finished = true;
            return true;
        }
        if (t.pkt->stream_index != t.stream) { av_packet_unref(t.pkt); continue; }

        AVSubtitle sub{};
        int got = 0;
        const int used = avcodec_decode_subtitle2(t.dec, &sub, &got, t.pkt);
        av_packet_unref(t.pkt);
        if (used < 0) {
            // One unreadable cue is not a reason to lose the rest of them.
            LOG_WARN("subtitles: a cue in %s would not decode", t.in.path.c_str());
            continue;
        }
        if (!got) continue;

        // Where this cue is, on the input's own clock. `sub.pts` is
        // AV_TIME_BASE_Q and the display times are milliseconds relative to it,
        // which is libavcodec's arrangement rather than one chosen here; the
        // epoch is what turns the container's timestamp into the input's, and
        // it has to come off before anything is compared with `from` or `to`.
        const double base =
            (sub.pts != AV_NOPTS_VALUE ? sub.pts / double(AV_TIME_BASE) : 0.0) - t.zero;
        const double start = base + sub.start_display_time / 1000.0;
        const double end = base + sub.end_display_time / 1000.0;
        // How far this tap has read, in *output* seconds — which is the clock
        // `pumpTo` is driven on, since it is called with the time of the frame
        // the writer has just written.
        t.at = std::max(t.at, start - t.from);

        const bool before = start < t.from - 1e-6;
        const bool after = t.to > 0.0 && start > t.to + 1e-6;
        if (after) {
            avsubtitle_free(&sub);
            t.finished = true;
            return true;
        }
        if (before) { avsubtitle_free(&sub); continue; }

        const int64_t fromMs = std::llround((start - t.from) * 1000.0);
        const int64_t toMs = std::llround((std::max(start, end) - t.from) * 1000.0);
        const bool ok = w.writeSubtitle(t.desc, &sub, fromMs, toMs, err);
        avsubtitle_free(&sub);
        if (!ok) return false;
        ++cues_;
    }
}

} // namespace ffmpegbro
