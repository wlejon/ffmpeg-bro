// The packet path. See export_copy.h.

#include "export_copy.h"

#include "export_writer.h"

#include "util/log.h"

extern "C" {
#include <libavutil/avutil.h>
#include <libavutil/mathematics.h>
}

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>

namespace ffmpegbro {
namespace {

/// A deadline for a packet walk, or no deadline at all.
///
/// **Checked every `CHECK_EVERY` packets rather than on each one**, because a
/// steady-clock read next to an `av_read_frame` that came out of a memory-mapped
/// local file is a measurable share of the loop, and the granularity this buys —
/// a few hundred packets, which is a fraction of a second even on a fast disk —
/// is far finer than any budget worth setting.
class Deadline {
  public:
    explicit Deadline(int ms)
        : on_(ms > 0),
          end_(std::chrono::steady_clock::now() + std::chrono::milliseconds(ms > 0 ? ms : 0)) {}

    /// True when the budget is spent. Call once per packet; it does the counting.
    bool spent() {
        if (!on_) return false;
        if (++seen_ < CHECK_EVERY) return false;
        seen_ = 0;
        return std::chrono::steady_clock::now() >= end_;
    }

  private:
    static constexpr int CHECK_EVERY = 64;
    bool on_ = false;
    std::chrono::steady_clock::time_point end_;
    int seen_ = 0;
};

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

/// The first timestamp this stream's own packets carry. The reason it is not
/// the container's `start_time` is `streamZero`'s, in export_copy.h.
int64_t streamOrigin(AVStream* st) {
    if (avformat_index_get_entries_count(st) > 0) {
        const AVIndexEntry* e = avformat_index_get_entry(st, 0);
        if (e && e->timestamp != AV_NOPTS_VALUE) return e->timestamp;
    }
    return st->start_time != AV_NOPTS_VALUE ? st->start_time : 0;
}

/// The same moment, as `av_seek_frame` wants to hear it: the exact inverse of
/// `streamZero`, which is the clock every number handed to this was measured on.
///
/// **It was `inputSeekTarget` alone, and the stream's own origin was missing.**
/// `keyframesOf` answers `raw − streamZero`, a caller picks one of those
/// numbers, hands it back as `copyFrom`, and this turned it into a target with
/// `ss` and `itsoffset` on it but not the origin. On these recordings the video
/// stream's origin is **34 milliseconds** — so the target came out 34 ms before
/// the keyframe it was meant to be, `AVSEEK_FLAG_BACKWARD` did exactly what it
/// says and landed on the one before *that*, and a copy asked for a window
/// beginning at a keyframe began a whole GOP — two seconds — earlier. Nothing
/// in the file said so; what noticed was `supercut/cuts.js` measuring a clip's
/// new in-point against the moment it asked for and putting every clip two
/// seconds off the word it was cut around.
///
/// A seek that is early is safe and a seek that is late loses packets, which is
/// why this is the direction it can be wrong in — but "safe" here cost a
/// two-second GOP for a thirty-millisecond mistake, and the fix is to be exact.
int64_t seekTarget(AVStream* st, const MediaInput& in, double at) {
    return static_cast<int64_t>(std::llround((at + streamZero(st, in)) /
                                             av_q2d(st->time_base)));
}

} // namespace

// See export_copy.h for why this is the stream's own first packet rather than
// the container's start.
double streamZero(AVStream* st, const MediaInput& in) {
    return streamOrigin(st) * av_q2d(st->time_base) + in.ss - in.itsoffset;
}

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
                 int budgetMs, KeyframeList* out, std::string* err) {
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
    Deadline until(budgetMs);
    for (;;) {
        av_packet_unref(pkt);
        // The deadline is judged on packets *read* and not on keyframes kept:
        // what costs the time is the reading, and a stream whose keyframes are
        // far apart is exactly the one that would otherwise run past it.
        if (until.spent()) break;
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

// ── Where the cues are ─────────────────────────────────────────────────────

bool cueTimesOf(const MediaInput& in, int stream, double from, double to, int max,
                int budgetMs, CueTimes* out, std::string* err) {
    AVFormatContext* fmt = nullptr;
    if (!openInput(&fmt, in, err)) return false;

    if (stream < 0) stream = av_find_best_stream(fmt, AVMEDIA_TYPE_SUBTITLE, -1, -1, nullptr, 0);
    if (stream < 0 || static_cast<unsigned>(stream) >= fmt->nb_streams ||
        fmt->streams[stream]->codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE) {
        // Named as the wrong kind rather than as an absence when the caller
        // asked for a particular stream: "stream 1 is audio" is actionable and
        // "no cues" is a file somebody goes looking through.
        *err = in.path + (stream >= 0 && static_cast<unsigned>(stream) < fmt->nb_streams
                              ? " stream " + std::to_string(stream) + " is not subtitles"
                              : " has no subtitle stream to read cues from");
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

    for (unsigned i = 0; i < fmt->nb_streams; ++i)
        fmt->streams[i]->discard = (static_cast<int>(i) == stream) ? AVDISCARD_DEFAULT
                                                                   : AVDISCARD_ALL;
    // Seeked backward and on the subtitle stream itself, which are the two
    // decisions every seek in this file makes — but note what `from` means
    // here: it bounds what is *listed*, not what a copy would take. A copy
    // seeks backward too and then carries the cue that was on screen at its
    // in-point, so a caller working that difference out asks for the whole
    // track and compares. Making this window mean the copy's would hide the
    // one cue the comparison is about.
    if (from > 0.0)
        av_seek_frame(fmt, stream, seekTarget(st, in, from), AVSEEK_FLAG_BACKWARD);

    AVPacket* pkt = av_packet_alloc();
    if (!pkt) { *err = "out of memory"; avformat_close_input(&fmt); return false; }
    Deadline until(budgetMs);
    for (;;) {
        av_packet_unref(pkt);
        if (until.spent()) break;
        if (av_read_frame(fmt, pkt) < 0) { out->complete = true; break; }
        if (pkt->stream_index != stream || !haveStamp(pkt)) continue;
        const double t = stampOf(pkt) * av_q2d(st->time_base) - epoch;
        if (to > 0.0 && t > to + 1e-6) { out->complete = true; break; }
        if (t < from - 1e-6) continue;
        Cue c;
        c.start = t;
        c.end = pkt->duration > 0 ? t + pkt->duration * av_q2d(st->time_base) : t;
        c.bytes = pkt->size;
        out->cues.push_back(c);
        if (static_cast<int>(out->cues.size()) >= max) break;
    }
    av_packet_free(&pkt);
    avformat_close_input(&fmt);
    // Left in the order they were read rather than sorted, which is the one
    // place this differs from `keyframesOf` on purpose: cues are presentation
    // times and do not reorder, so a list that arrived out of order is a fact
    // about the file — an overlapping pair in an ASS track, layered on
    // purpose — and sorting it would hide the only evidence of it.
    return true;
}

// ── The copied streams of one render ───────────────────────────────────────

CopyStreams::Reader::~Reader() {
    if (pending) av_packet_free(&pending);
    for (AVPacket* p : primed) av_packet_free(&p);
    primed.clear();
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
            if (earliest < 0 || t.from < earliest) earliest = t.from;
            const double end = t.to > 0.0 ? t.to : duration;
            if (end > 0.0) longest = std::max(longest, end - t.from);
        }

        // **Seeked on the picture wherever there is one, and that is not a
        // preference.** Only the video stream has sparse keyframes; every audio
        // packet is one, so `av_seek_frame` on a soundtrack lands *anywhere* and
        // the video packets that follow start in the middle of a GOP. Matroska
        // then reports what it was given — "File is broken, keyframes not
        // correctly marked", then a non-monotonic dts — and the copy fails with
        // nothing on disk.
        //
        // This used to be whichever tap held the earliest in-point, ties going
        // to the first in the list, which made the *order of the stream rows*
        // decide whether a windowed copy worked. `copyRowsOf` lists a file's
        // streams in the container's order, so a recording muxed with its
        // soundtrack as stream 0 — which Twitch's are — took the audio and
        // broke, and one muxed picture-first took the video and worked.
        //
        // Safe whatever the in-points are, because every seek here is
        // `AVSEEK_FLAG_BACKWARD` and the target is the moment as the timeline
        // means it (`inputSeekTarget`, with none of the stream's own origin on
        // it): landing at or before the earliest thing anybody asked for is the
        // whole contract, and a picture keyframe at or before it satisfies it.
        double fallbackFrom = 0.0;
        for (const auto& t : r->taps) {
            if (r->fmt->streams[t.stream]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
                earliestStream = t.stream;
                break;
            }
            // No picture in this input: the old rule, which is the best there is
            // when every stream is keyframes all the way down.
            if (earliestStream < 0 || t.from < fallbackFrom) {
                earliestStream = t.stream;
                fallbackFrom = t.from;
            }
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

/// How far `prime` will read to settle the epoch.
///
/// A bound rather than a certainty, because a tapped stream may simply have no
/// packets left — a subtitle track whose last cue was an hour ago, a data track
/// that ended — and waiting for one would read the rest of the file into memory.
/// Two hundred packets is several times more than the interleave of any sane
/// container and is a few hundred kilobytes at worst.
static constexpr size_t kPrimePackets = 200;

/// How much a *windowed* copy will hold while it looks for its own beginning.
///
/// Not the same bound and not the same job: this one buffers from a keyframe up
/// to the in-point and throws the lot away every time a later keyframe arrives,
/// so what it actually holds is one GOP — a hundred and twenty packets and a
/// megabyte and a half on a 1080p60 recording with the two-second GOPs these
/// have. Three thousand is the point at which the file has no keyframe coming
/// and the search has to stop being one; it is a guard against a pathological
/// stream rather than a number any real file reaches.
static constexpr size_t kPrimeGopPackets = 3000;

/// Does a packet from *before* a window's in-point still belong to the copy?
///
/// Two kinds of stream say yes and they say it for the same reason: their
/// packets are still in force at the in-point. A picture before it is what makes
/// the pictures after it decodable — that is the whole of why a copy begins at a
/// keyframe — and a cue before it is still on the screen at it, which is
/// `cueTimesOf`'s finding and what the Write stage means by a copied subtitle
/// window starting at the cue rather than at the moment.
///
/// A sound packet is over before the in-point and a data sample is a reading
/// taken before it. Neither was asked for, and taking a copy's zero from one was
/// what made every windowed copy begin a GOP early.
static bool keepsEarly(AVMediaType kind) {
    return kind == AVMEDIA_TYPE_VIDEO || kind == AVMEDIA_TYPE_SUBTITLE;
}

void CopyStreams::prime(Reader& r) {
    if (r.haveEpoch) return;

    // **The zero is the earliest thing this copy will emit, and no single packet
    // knows what that is.** A seek lands at or before the in-point on the stream
    // it was measured against, and the other streams of the same input land
    // wherever their own interleave puts them — routinely a few milliseconds
    // *earlier* than the video keyframe that was sought to. Taking the epoch
    // from whichever packet arrived first therefore shifted every one of those
    // to a negative timestamp, and a muxer refuses them:
    //
    //   Application provided invalid, non monotonically increasing dts
    //     to muxer in stream 1: -16 >= -34
    //
    // Whether a given file tripped it was a matter of where its GOPs fell, which
    // is why this survived so long: of the three renditions of one recording,
    // the 480p and the audio-only copied cleanly and the 1080p60 could not be
    // windowed at all.
    //
    // So the first packet of *every* tapped stream is looked at before the epoch
    // is chosen, and the earliest of them wins. What is read to find out is kept
    // in `r.primed` — those packets are the start of the copy, not a probe.
    double earliest = 0.0;
    bool any = false;

    // The moment asked for still takes part, and still only moves the zero
    // earlier — a keyframe found at 4.0 for a cut asked at 4.2 comes out at
    // zero, and an untrimmed subtitle track whose first cue is a minute in
    // stays a minute in. With several taps it is the earliest of them, because
    // that is the one `open()` seeked to.
    for (const auto& t : r.taps) {
        if (t.finished) continue;
        const double asked = t.from + t.zero;
        if (!any || asked < earliest) { earliest = asked; any = true; }
    }

    // **A window's zero is the moment it asked for; a whole file's is the
    // earliest packet there is.** Those are two different questions, and this
    // answered both with the second one — which put every windowed copy a GOP
    // early. `supercut/cuts.js` measures a clip's new in-point against the
    // moment it asked for, so every cut it made came out two seconds off and
    // the word each one was cut around fell outside the clip.
    r.trimsHead = false;
    for (const auto& t : r.taps) if (!t.finished && t.from > 0.0) r.trimsHead = true;

    if (!r.trimsHead) {
        // The whole of the input, so nothing is dropped and the zero is the
        // earliest packet there is. The first packet of *every* tapped stream
        // is looked at before it is chosen, because a container's streams do
        // not all begin together and the earliest of them is the only answer a
        // muxer will take.
        std::vector<int> want;
        for (const auto& t : r.taps)
            if (!t.finished &&
                std::find(want.begin(), want.end(), t.stream) == want.end())
                want.push_back(t.stream);

        for (size_t read = 0; read < kPrimePackets && !want.empty(); ++read) {
            AVPacket* pkt = av_packet_alloc();
            if (!pkt) break;
            if (av_read_frame(r.fmt, pkt) < 0) { av_packet_free(&pkt); break; }
            r.primed.push_back(pkt);
            if (!haveStamp(pkt)) continue;
            const auto at = std::find(want.begin(), want.end(), pkt->stream_index);
            if (at == want.end()) continue;
            want.erase(at);
            const AVRational tb = r.fmt->streams[pkt->stream_index]->time_base;
            const double raw = stampOf(pkt) * av_q2d(tb);
            if (!any || raw < earliest) { earliest = raw; any = true; }
        }
    } else {
        // **A window begins at the last keyframe at or before its in-point, and
        // where the seek landed does not decide which one that is.** These
        // recordings carry no index — `keyframesOf` says `how: "scan"` on them —
        // so `av_seek_frame` binary-searches the file and comes back with
        // whatever keyframe it happened to find: asked for the one at 1214.017
        // it answered with the one at 1212.034, two seconds and a whole GOP
        // early. Seeking more exactly cannot fix that; a file with nothing to
        // look the answer up in has no exact seek in it.
        //
        // So the copy finds its own beginning. Every keyframe that is still at
        // or before the in-point makes every picture read so far unnecessary —
        // and the sound read with them is sound from before the window, which
        // `fill` drops anyway — so they are thrown away and the read goes on.
        // What is left when the in-point is reached is one GOP, which is the
        // beginning of the copy.
        int vstream = -1;
        double vasked = 0.0;
        for (const auto& t : r.taps) {
            if (t.finished) continue;
            if (r.fmt->streams[t.stream]->codecpar->codec_type != AVMEDIA_TYPE_VIDEO)
                continue;
            vstream = t.stream;
            vasked = t.from + t.zero;
            break;
        }

        const auto timeOf = [&](const AVPacket* p) {
            return stampOf(p) * av_q2d(r.fmt->streams[p->stream_index]->time_base);
        };

        while (vstream >= 0 && r.primed.size() < kPrimeGopPackets) {
            AVPacket* pkt = av_packet_alloc();
            if (!pkt) break;
            if (av_read_frame(r.fmt, pkt) < 0) { av_packet_free(&pkt); break; }
            const bool picture = pkt->stream_index == vstream && haveStamp(pkt);
            if (picture && (pkt->flags & AV_PKT_FLAG_KEY) && timeOf(pkt) <= vasked + 1e-9) {
                // A later beginning: every picture read so far is one nothing
                // after it needs, and the sound read with them is sound from
                // before the window. A **cue** read with them is not — it may
                // still be on the screen at the in-point — so it stays, in the
                // order it arrived, and `keepsEarly` is the one place that says
                // which of the two a stream is.
                std::deque<AVPacket*> keep;
                for (AVPacket* old : r.primed) {
                    AVPacket* p = old;
                    if (r.fmt->streams[p->stream_index]->codecpar->codec_type ==
                        AVMEDIA_TYPE_SUBTITLE)
                        keep.push_back(p);
                    else
                        av_packet_free(&p);
                }
                r.primed.swap(keep);
            }
            r.primed.push_back(pkt);
            // The in-point, and the end of the search: what is buffered now
            // begins with the keyframe the copy begins at.
            if (picture && timeOf(pkt) >= vasked - 1e-9) break;
        }

        // **A cue on the screen at the in-point is part of this copy too**, and
        // a subtitle track with no picture beside it is read here and nowhere
        // else — the loop above never ran for it. Bounded by `kPrimePackets`
        // because a track may simply have no cue anywhere near, and the seek
        // landed before the in-point, so the first one read is the one that
        // straddles it.
        std::vector<int> want;
        for (const auto& t : r.taps)
            if (!t.finished &&
                r.fmt->streams[t.stream]->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE &&
                std::find(want.begin(), want.end(), t.stream) == want.end())
                want.push_back(t.stream);
        for (const AVPacket* p : r.primed) {
            const auto seen = std::find(want.begin(), want.end(), p->stream_index);
            if (seen != want.end()) want.erase(seen);
        }
        for (size_t read = 0; read < kPrimePackets && !want.empty(); ++read) {
            AVPacket* pkt = av_packet_alloc();
            if (!pkt) break;
            if (av_read_frame(r.fmt, pkt) < 0) { av_packet_free(&pkt); break; }
            r.primed.push_back(pkt);
            const auto seen = std::find(want.begin(), want.end(), pkt->stream_index);
            if (seen != want.end()) want.erase(seen);
        }

        // The zero is the earliest thing this copy will emit, and now that is
        // knowable rather than guessed at: everything it emits from before the
        // in-point has been read and is in the buffer. Anything else early is
        // dropped in `fill`, and everything from the in-point onward is at or
        // after `earliest` already.
        for (const AVPacket* p : r.primed) {
            if (!haveStamp(p)) continue;
            if (!keepsEarly(r.fmt->streams[p->stream_index]->codecpar->codec_type)) continue;
            const double at = timeOf(p);
            if (!any || at < earliest) { earliest = at; any = true; }
        }
    }

    r.haveEpoch = true;
    r.epochUs = any ? static_cast<int64_t>(std::llround(earliest * AV_TIME_BASE)) : 0;
}

bool CopyStreams::readOne(Reader& r, AVPacket* into) {
    if (!r.primed.empty()) {
        AVPacket* head = r.primed.front();
        r.primed.pop_front();
        av_packet_move_ref(into, head);
        av_packet_free(&head);
        return true;
    }
    return av_read_frame(r.fmt, into) >= 0;
}

void CopyStreams::fill(Reader& r) {
    prime(r);
    while (!r.havePending && !r.eof) {
        av_packet_unref(r.pending);
        if (!readOne(r, r.pending)) { r.eof = true; break; }
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
            // The head of the window, which for years only the tail of it had.
            // What is exempt and why is `keepsEarly`'s; `prime` reads the same
            // rule to decide where the copy's zero is, and the two must agree or
            // a packet is emitted before the file starts.
            if (r.trimsHead && when < t.from - 1e-9 &&
                !keepsEarly(r.fmt->streams[t.stream]->codecpar->codec_type))
                continue;
            if (r.pendingTaps.empty()) at = when;
            r.pendingTaps.push_back(&t);
        }
        if (r.pendingTaps.empty()) {
            bool any = false;
            for (const auto& t : r.taps) if (!t.finished) any = true;
            if (!any) r.eof = true;
            continue;
        }

        // The epoch is `prime()`'s, settled before any of this ran. One zero per
        // input rather than one per stream is the whole of A/V sync across a
        // copy: taken per stream, a soundtrack would move by however far the
        // picture's first keyframe was from it.
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
