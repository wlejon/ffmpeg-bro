// The packet path. See export_copy.h.

#include "export_copy.h"

#include "export_writer.h"

#include "util/log.h"

extern "C" {
#include <libavutil/avutil.h>
#include <libavutil/mathematics.h>
}

#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace ffmpegbro {
namespace {

/// The timestamp to judge a packet by. `dts` is the decode order and the one
/// that is always present and always monotonic, which is what both the epoch
/// and the end of a span want; `pts` on a stream with B-frames runs ahead of it
/// and would put the cut in a different place on each of two identical streams.
int64_t stampOf(const AVPacket* pkt) {
    if (pkt->dts != AV_NOPTS_VALUE) return pkt->dts;
    return pkt->pts;
}

bool haveStamp(const AVPacket* pkt) {
    return pkt->dts != AV_NOPTS_VALUE || pkt->pts != AV_NOPTS_VALUE;
}

/// Where one stream's own packet clock starts, in seconds.
///
/// **A packet clock is not a frame clock, and this is where that bites.** The
/// rest of this renderer measures an input from the container's `start_time`,
/// which is where the first *picture is presented*. A packet carries a decode
/// timestamp, and for anything with B-frames in it the first one is the reorder
/// delay *earlier* — two frames, 80 ms at 25 fps, in every mp4 this application
/// writes. Measured the container's way, the first keyframe of the fixture came
/// out at −0.08 s, fell outside a window starting at zero, and the second
/// keyframe of the file was offered as the first place a cut could start.
///
/// So a copy counts from the stream's own first packet — which is the demuxer's
/// index entry zero where there is an index, and `start_time` where there is
/// not. `st->start_time` alone is not enough: an mp4's edit list puts it at
/// zero while the packets still begin at −0.08, which is the whole of the bug
/// above. The result is that a copy's clock and the file it writes agree — a
/// cut at 2 s starts 2 s in and the output starts at zero — and that the
/// keyframes a UI snaps to are the numbers the render seeks to.
int64_t streamOrigin(AVStream* st) {
    if (avformat_index_get_entries_count(st) > 0) {
        const AVIndexEntry* e = avformat_index_get_entry(st, 0);
        if (e && e->timestamp != AV_NOPTS_VALUE) return e->timestamp;
    }
    return st->start_time != AV_NOPTS_VALUE ? st->start_time : 0;
}

double streamZero(AVStream* st, const MediaInput& in) {
    return streamOrigin(st) * av_q2d(st->time_base) + in.ss - in.itsoffset;
}

/// The same moment, as `av_seek_frame` wants to hear it. The arithmetic and
/// the reason it is not `streamZero`'s live in `inputSeekTarget` — a demuxer's
/// seek clock is not its index's clock, and the subtitle path needs the same
/// answer this one does.
int64_t seekTarget(AVStream* st, const MediaInput& in, double at) {
    return inputSeekTarget(st->time_base, in, at);
}

} // namespace

bool parseCopySource(const std::string& source, int* input, int* stream) {
    if (!isCopySource(source)) return false;
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

// ── Where a copy can start ─────────────────────────────────────────────────

bool keyframesOf(const MediaInput& in, int stream, double from, double to, int max,
                 KeyframeList* out, std::string* err) {
    AVFormatContext* fmt = nullptr;
    if (!openInput(&fmt, in, err)) return false;

    if (stream < 0) stream = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (stream < 0) stream = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (stream < 0 || static_cast<unsigned>(stream) >= fmt->nb_streams) {
        *err = in.path + " has no stream to find keyframes in";
        avformat_close_input(&fmt);
        return false;
    }

    AVStream* st = fmt->streams[stream];
    const double epoch = streamZero(st, in);
    const double limit = inputLimit(in);
    if (max <= 0) max = 4000;
    if (to <= 0.0 || (limit > 0.0 && to > limit)) to = limit;

    out->stream = stream;
    out->from = from;
    out->to = to;

    // The index first, because a container that has one has already answered.
    // mp4 and Matroska both do, and walking a few thousand entries is free next
    // to reading the file; a raw stream has none and is read instead.
    const int entries = avformat_index_get_entries_count(st);
    if (entries > 1) {
        out->how = "index";
        out->complete = true;
        for (int i = 0; i < entries; ++i) {
            const AVIndexEntry* e = avformat_index_get_entry(st, i);
            if (!e || !(e->flags & AVINDEX_KEYFRAME)) continue;
            const double t = e->timestamp * av_q2d(st->time_base) - epoch;
            if (t < from - 1e-6) continue;
            if (to > 0.0 && t > to + 1e-6) break;
            out->times.push_back(t);
            if (static_cast<int>(out->times.size()) >= max) { out->complete = false; break; }
        }
        avformat_close_input(&fmt);
        return true;
    }

    // No index: read the window. Every other stream is discarded in the demuxer
    // so a 1080p sibling costs nothing to walk past.
    out->how = "scan";
    for (unsigned i = 0; i < fmt->nb_streams; ++i)
        fmt->streams[i]->discard = (static_cast<int>(i) == stream) ? AVDISCARD_DEFAULT
                                                                   : AVDISCARD_ALL;
    // Seeked on the stream being asked about rather than on the file. A
    // whole-file seek is resolved against whichever stream libavformat calls
    // the default one, which for an interleaved mp4 is not the one in hand and
    // lands a GOP away from where it was aimed.
    if (from > 0.0)
        av_seek_frame(fmt, stream, seekTarget(st, in, from), AVSEEK_FLAG_BACKWARD);

    AVPacket* pkt = av_packet_alloc();
    if (!pkt) { *err = "out of memory"; avformat_close_input(&fmt); return false; }
    for (;;) {
        av_packet_unref(pkt);
        if (av_read_frame(fmt, pkt) < 0) { out->complete = true; break; }
        if (pkt->stream_index != stream || !haveStamp(pkt)) continue;
        const double t = stampOf(pkt) * av_q2d(st->time_base) - epoch;
        if (to > 0.0 && t > to + 1e-6) { out->complete = true; break; }
        if (t < from - 1e-6) continue;
        if (pkt->flags & AV_PKT_FLAG_KEY) out->times.push_back(t);
        if (static_cast<int>(out->times.size()) >= max) break;
    }
    av_packet_free(&pkt);
    avformat_close_input(&fmt);
    std::sort(out->times.begin(), out->times.end());
    return true;
}

// ── The copied streams of one render ───────────────────────────────────────

CopyStreams::Reader::~Reader() {
    if (pending) av_packet_free(&pending);
    if (fmt) avformat_close_input(&fmt);
}

CopyStreams::~CopyStreams() = default;

bool CopyStreams::build(const ExportSettings& s, const std::vector<ExportStream>& streams,
                        std::string* err) {
    for (size_t i = 0; i < streams.size(); ++i) {
        const ExportStream& desc = streams[i];
        if (!isCopySource(desc.source)) continue;

        int input = -1, stream = -1;
        if (!parseCopySource(desc.source, &input, &stream)) {
            *err = "'" + desc.source +
                   "' is not a stream to copy — a copied stream is written copy:<input>:<stream>";
            return false;
        }

        const MediaInput in = resolveInput(s, input, desc.path);
        if (in.path.empty()) {
            *err = "stream " + std::to_string(i) + " copies input " + std::to_string(input) +
                   ", and this render has no such input";
            return false;
        }

        // One reader per input, however many streams are taken from it: that is
        // what `-i` means, and it is what makes the file's zero one zero.
        Reader* reader = nullptr;
        for (auto& r : readers_) if (r->in == in) reader = r.get();
        if (!reader) {
            auto made = std::make_unique<Reader>();
            made->in = in;
            if (!openInput(&made->fmt, in, err)) return false;
            made->pending = av_packet_alloc();
            if (!made->pending) { *err = "out of memory"; return false; }
            reader = made.get();
            readers_.push_back(std::move(made));
        }

        if (stream < 0 || static_cast<unsigned>(stream) >= reader->fmt->nb_streams) {
            *err = in.path + " has " + std::to_string(reader->fmt->nb_streams) +
                   " streams, so there is no stream " + std::to_string(stream) + " to copy";
            return false;
        }

        Tap tap;
        tap.desc = i;
        tap.stream = stream;
        tap.zero = streamZero(reader->fmt->streams[stream], in);
        tap.from = std::max(0.0, desc.copyFrom);
        tap.to = desc.copyTo;
        const double limit = inputLimit(in);
        if (limit > 0.0 && (tap.to <= 0.0 || tap.to > limit)) tap.to = limit;
        reader->taps.push_back(tap);
        ++count_;
    }

    if (!count_) return true;

    // Each reader seeks to the earliest moment any of its taps wants, backward,
    // so it lands at or before the in-point and can never skip a packet the
    // copy still needs. Too early only costs a few frames at the head — which
    // is the cost a copy has and the reason the keyframes are shown.
    for (auto& r : readers_) {
        double earliest = -1.0;
        int earliestStream = -1;
        double longest = 0.0;
        const double duration = r->fmt->duration != AV_NOPTS_VALUE
                                    ? inputDuration(r->in, r->fmt->duration / double(AV_TIME_BASE))
                                    : 0.0;
        for (const auto& t : r->taps) {
            if (earliest < 0 || t.from < earliest) {
                earliest = t.from;
                earliestStream = t.stream;
            }
            const double end = t.to > 0.0 ? t.to : duration;
            if (end > 0.0) longest = std::max(longest, end - t.from);
        }
        span_ = std::max(span_, longest);
        for (unsigned i = 0; i < r->fmt->nb_streams; ++i) {
            bool wanted = false;
            for (const auto& t : r->taps) if (t.stream == static_cast<int>(i)) wanted = true;
            r->fmt->streams[i]->discard = wanted ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
        }
        if (earliest > 0.0 && earliestStream >= 0) {
            // Seeked on the stream the in-point was measured against, not on
            // the file. `av_seek_frame` with -1 resolves the target against
            // whichever stream libavformat calls the default, which in an
            // interleaved mp4 is not the one the keyframes were read off.
            AVStream* on = r->fmt->streams[earliestStream];
            const int rc = av_seek_frame(r->fmt, earliestStream,
                                         seekTarget(on, r->in, earliest), AVSEEK_FLAG_BACKWARD);
            if (rc < 0)
                LOG_WARN("copy: %s would not seek to %.3f s; copying from the start",
                         r->in.path.c_str(), earliest);
        }
    }
    return true;
}

const AVStream* CopyStreams::streamFor(size_t desc) const {
    for (const auto& r : readers_)
        for (const auto& t : r->taps)
            if (t.desc == desc) return r->fmt->streams[t.stream];
    return nullptr;
}

double CopyStreams::outSecondsOf(const Reader& r, const AVPacket* pkt) const {
    const AVRational tb = r.fmt->streams[pkt->stream_index]->time_base;
    return stampOf(pkt) * av_q2d(tb) - r.epochUs / double(AV_TIME_BASE);
}

void CopyStreams::fill(Reader& r) {
    while (!r.havePending && !r.eof) {
        av_packet_unref(r.pending);
        if (av_read_frame(r.fmt, r.pending) < 0) { r.eof = true; break; }
        if (!haveStamp(r.pending)) continue;

        // Every tap this packet is for, not one of them. Two output streams may
        // copy one input stream, and each one's window is its own — so a packet
        // past the end of the first is still inside the second, and the search
        // is per tap all the way down.
        r.pendingTaps.clear();
        double at = 0.0;
        for (auto& t : r.taps) {
            if (t.finished || t.stream != r.pending->stream_index) continue;
            const AVRational tb = r.fmt->streams[t.stream]->time_base;
            const double when = stampOf(r.pending) * av_q2d(tb) - t.zero;
            if (t.to > 0.0 && when > t.to + 1e-9) { t.finished = true; continue; }
            if (r.pendingTaps.empty()) at = when;
            r.pendingTaps.push_back(&t);
        }
        if (r.pendingTaps.empty()) {
            bool any = false;
            for (const auto& t : r.taps) if (!t.finished) any = true;
            if (!any) r.eof = true;
            continue;
        }

        // The first packet out of this input decides its zero, for every stream
        // taken from it. One zero per input rather than one per stream is the
        // whole of A/V sync across a copy: taken per stream, a soundtrack would
        // move by however far the picture's first keyframe was from it.
        if (!r.haveEpoch) {
            const AVRational tb = r.fmt->streams[r.pending->stream_index]->time_base;
            r.haveEpoch = true;
            r.epochUs = static_cast<int64_t>(std::llround(stampOf(r.pending) * av_q2d(tb) *
                                                          AV_TIME_BASE));
            if (!started_) { started_ = true; startedAt_ = at; }
        }
        r.havePending = true;
    }
}

bool CopyStreams::pumpTo(double until, Writer& w, std::string* err) {
    for (auto& reader : readers_) {
        Reader& r = *reader;
        for (;;) {
            fill(r);
            if (!r.havePending) break;
            const double at = outSecondsOf(r, r.pending);
            if (until > 0.0 && at >= until) break;

            // Rescaled from the input's clock to the copy's, still in the input
            // stream's own time base: the writer takes it from there into the
            // output stream's exactly as it takes an encoder's packets.
            const AVRational tb = r.fmt->streams[r.pending->stream_index]->time_base;
            const int64_t shift = av_rescale_q(r.epochUs, AVRational{1, AV_TIME_BASE}, tb);
            if (r.pending->pts != AV_NOPTS_VALUE) r.pending->pts -= shift;
            if (r.pending->dts != AV_NOPTS_VALUE) r.pending->dts -= shift;
            r.pending->pos = -1;

            // The muxer takes the reference it is given, so every tap past the
            // first gets one of its own. One tap is the ordinary case and pays
            // nothing for the general one.
            for (size_t i = 0; i + 1 < r.pendingTaps.size(); ++i) {
                AVPacket* copy = av_packet_alloc();
                if (!copy || av_packet_ref(copy, r.pending) < 0) {
                    if (copy) av_packet_free(&copy);
                    *err = "out of memory copying a packet into two streams";
                    return false;
                }
                const bool ok = w.writeCopiedPacket(r.pendingTaps[i]->desc, copy, err);
                av_packet_free(&copy);
                if (!ok) return false;
                ++packets_;
            }
            if (!w.writeCopiedPacket(r.pendingTaps.back()->desc, r.pending, err)) return false;
            position_ = std::max(position_, at);
            ++packets_;
            r.havePending = false;
        }
    }
    return true;
}

bool CopyStreams::done() const {
    for (const auto& r : readers_) if (!r->eof || r->havePending) return false;
    return true;
}

} // namespace ffmpegbro
