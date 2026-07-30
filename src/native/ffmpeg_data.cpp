// Reading a data track: which parser, then the walk over the packets, then the
// reduction to something a lane can draw. See ffmpeg_data.h.

#include "ffmpeg_data.h"

#include "async_open.h"
#include "data_gpmf.h"
#include "export_frame.h"   // avErr

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
}

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

/// The registry. One row, and the row is a fourcc rather than a camera.
///
/// A table rather than an `if` because the shape is the point: the second entry
/// is a line, and the thing that decides is the container's own tag. What is
/// *not* here is as deliberate — a real HERO8 file carries `tmcd`, `fdsc` and
/// often `mebx` beside its `gpmd`, and none of those has a parser, so each is
/// reported as a data track with nothing that reads it rather than being run
/// through the wrong one.
struct Registered {
    const char* tag;
    DataParser parse;
};

const Registered kParsers[] = {
    { "gpmd", &readGpmfPayload },
};

std::string tagOf(const AVStream* st) {
    if (!st || !st->codecpar || !st->codecpar->codec_tag) return {};
    char fourcc[AV_FOURCC_MAX_STRING_SIZE] = {};
    av_fourcc_make_string(fourcc, st->codecpar->codec_tag);
    return fourcc;
}

DataReading fail(const std::string& why) {
    DataReading r;
    r.error = why;
    return r;
}

/// One series being built: the buckets, plus the exact statistics folded over
/// every sample rather than over the buckets.
struct Building {
    DataSeries s;
    std::vector<double> bucketSum;
    std::vector<int32_t> bucketN;
    double firstT = 0.0, lastT = 0.0;
    bool any = false;
};

} // namespace

DataParser parserForTag(const std::string& tag) {
    for (const Registered& r : kParsers)
        if (tag == r.tag) return r.parse;
    return nullptr;
}

std::vector<std::string> dataParserTags() {
    std::vector<std::string> out;
    for (const Registered& r : kParsers) out.push_back(r.tag);
    return out;
}

DataReading readDataStream(const MediaInput& in, int streamIndex, int buckets,
                           OpenWatch* watch) {
    if (buckets <= 0) buckets = kDataBuckets;
    // Refused rather than clamped: a caller asking for a million has a bug, and
    // a silently smaller answer is how it would go unnoticed.
    if (buckets > kMaxDataBuckets)
        return fail("a reading of more than " + std::to_string(kMaxDataBuckets) +
                    " buckets was asked for");

    AVFormatContext* fmt = nullptr;
    std::string err;
    if (!openInput(&fmt, in, &err, watch)) return fail(err);
    struct Closer {
        AVFormatContext* f;
        ~Closer() { if (f) avformat_close_input(&f); }
    } closer{fmt};

    if (streamIndex < 0 || streamIndex >= int(fmt->nb_streams))
        return fail("there is no stream " + std::to_string(streamIndex) + " in " + in.path);

    AVStream* st = fmt->streams[streamIndex];
    const std::string tag = tagOf(st);
    DataParser parse = parserForTag(tag);
    if (!parse) {
        return fail(tag.empty()
                        ? "stream " + std::to_string(streamIndex) + " carries no fourcc, "
                          "which is the only thing that could say what is in it"
                        : "nothing here parses '" + tag + "'");
    }

    // **Every other stream discarded, before the first packet.** Without this a
    // 4 GB file is 4 GB of video demuxed and thrown away: measured on one, the
    // same read is **13.3 s** with every stream enabled and **32 ms** with only
    // the data track, because `av_read_frame` hands back every packet and the
    // cost is reading them off the disk rather than looping over them. It is a
    // 415× difference and it is the difference between this being a thing a
    // button can do and a thing it cannot.
    for (unsigned i = 0; i < fmt->nb_streams; ++i)
        fmt->streams[i]->discard = (int(i) == streamIndex) ? AVDISCARD_DEFAULT
                                                           : AVDISCARD_ALL;

    DataReading out;
    out.tag = tag;
    out.streamIndex = streamIndex;
    out.buckets = buckets;

    // The track's own span, on the container's clock — which is the clock the
    // timeline draws on, and the reason the samples are placed by packet
    // timestamp rather than by GPMF's own `STMP`. `STMP` is the camera's clock
    // and starts wherever the sensor did (105 094 µs into a HERO8 recording
    // whose first packet is at 0), so using it would offset every series by an
    // amount nothing else here knows about.
    const AVRational tb = st->time_base;
    double span = (st->duration > 0 && tb.den > 0)
                      ? double(st->duration) * tb.num / tb.den
                      : 0.0;
    if (span <= 0 && fmt->duration > 0) span = double(fmt->duration) / AV_TIME_BASE;
    if (span <= 0) span = 1.0;
    out.t0 = 0.0;
    out.t1 = span;

    std::map<std::string, size_t> index;   ///< "ACCL/0" → slot in `built`
    std::vector<Building> built;

    AVPacket* pkt = av_packet_alloc();
    if (!pkt) return fail("out of memory");
    struct PktFree {
        AVPacket** p;
        ~PktFree() { av_packet_free(p); }
    } pktFree{&pkt};

    int64_t bytes = 0;
    double lastPts = 0.0, lastDur = 0.0;

    while (av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index != streamIndex || pkt->size <= 0) {
            av_packet_unref(pkt);
            continue;
        }
        bytes += pkt->size;
        if (bytes > kMaxDataBytes) {
            av_packet_unref(pkt);
            out.error = "the track is larger than this will read (" +
                        std::to_string(kMaxDataBytes) + " bytes)";
            return out;
        }

        const double pts = (pkt->pts != AV_NOPTS_VALUE && tb.den > 0)
                               ? double(pkt->pts) * tb.num / tb.den
                               : lastPts + lastDur;
        // A packet with no duration of its own is given the previous one's,
        // which is what every timed data track in practice has. Zero for the
        // very first such packet puts its samples all at one instant, which is
        // visibly wrong rather than quietly wrong.
        double dur = (pkt->duration > 0 && tb.den > 0)
                         ? double(pkt->duration) * tb.num / tb.den
                         : lastDur;
        lastPts = pts;
        if (dur > 0) lastDur = dur;

        const DataPayload payload = parse(pkt->data, size_t(pkt->size));
        ++out.packets;
        if (!payload.refusal.empty()) {
            ++out.refused;
            if (out.refusal.empty())
                out.refusal = "packet " + std::to_string(out.packets - 1) + ": " +
                              payload.refusal;
        }
        if (out.device.empty()) out.device = payload.device;

        // **A series is a key and a component, and nothing else.** A payload may
        // carry the same key in two of its streams — a HERO8 writes `TMPC` in
        // both the accelerometer's and the gyroscope's, and it is one camera
        // temperature — so they are one series here. The cost is stated rather
        // than hidden: a format that used one fourcc for two different
        // quantities would have them merged, and GPMF offers nothing to tell two
        // streams apart with except their `STNM`, which is a sentence rather
        // than an id.
        for (const DataItem& item : payload.items) {
            if (item.count <= 0 || item.components <= 0) continue;
            for (int c = 0; c < item.components; ++c) {
                const std::string key = item.key + "/" + std::to_string(c);
                auto it = index.find(key);
                if (it == index.end()) {
                    if (int(built.size()) >= kMaxDataSeries) continue;
                    Building b;
                    b.s.key = item.key;
                    b.s.name = item.name;
                    b.s.component = c;
                    b.s.components = item.components;
                    b.s.scaled = item.scaled;
                    // One unit per component, or one for all of them, or none.
                    if (item.units.size() == size_t(item.components))
                        b.s.units = item.units[size_t(c)];
                    else if (item.units.size() == 1)
                        b.s.units = item.units[0];
                    b.s.min = std::numeric_limits<double>::infinity();
                    b.s.max = -std::numeric_limits<double>::infinity();
                    b.s.lo.assign(size_t(buckets), 0.0f);
                    b.s.hi.assign(size_t(buckets), 0.0f);
                    b.s.mean.assign(size_t(buckets), 0.0f);
                    b.s.filled.assign(size_t(buckets), 0);
                    b.bucketSum.assign(size_t(buckets), 0.0);
                    b.bucketN.assign(size_t(buckets), 0);
                    it = index.emplace(key, built.size()).first;
                    built.push_back(std::move(b));
                }
                Building& b = built[it->second];

                for (int s = 0; s < item.count; ++s) {
                    const double v = item.values[size_t(s) * size_t(item.components) +
                                                 size_t(c)];
                    if (!std::isfinite(v)) continue;
                    // Samples are spread evenly across the packet they arrived
                    // in. Two clocks were available and this is the one that
                    // cannot place a sample outside the packet that carried it
                    // — the alternative, a rate measured over the whole track,
                    // puts the last packet's samples past the end of the file,
                    // because a HERO8's final `gpmd` packet declares 41 ms and
                    // holds 17 accelerometer samples worth 85 ms.
                    const double t = pts + (item.count > 1
                                                ? dur * double(s) / double(item.count)
                                                : 0.0);
                    int bi = int((t - out.t0) / (out.t1 - out.t0) * double(buckets));
                    bi = std::clamp(bi, 0, buckets - 1);

                    if (!b.s.filled[size_t(bi)]) {
                        b.s.lo[size_t(bi)] = float(v);
                        b.s.hi[size_t(bi)] = float(v);
                        b.s.filled[size_t(bi)] = 1;
                    } else {
                        b.s.lo[size_t(bi)] = std::min(b.s.lo[size_t(bi)], float(v));
                        b.s.hi[size_t(bi)] = std::max(b.s.hi[size_t(bi)], float(v));
                    }
                    b.bucketSum[size_t(bi)] += v;
                    ++b.bucketN[size_t(bi)];

                    // Exact, over every sample — the numbers a readout shows
                    // are never the decimated ones.
                    b.s.min = std::min(b.s.min, v);
                    b.s.max = std::max(b.s.max, v);
                    ++b.s.samples;
                    if (!b.any) { b.firstT = t; b.any = true; }
                    b.lastT = t;
                }
            }
        }
        av_packet_unref(pkt);
    }

    if (out.packets == 0) {
        out.error = "there are no packets on stream " + std::to_string(streamIndex);
        return out;
    }

    for (Building& b : built) {
        if (b.s.samples <= 0) continue;
        for (int i = 0; i < buckets; ++i)
            if (b.bucketN[size_t(i)] > 0)
                b.s.mean[size_t(i)] = float(b.bucketSum[size_t(i)] /
                                            double(b.bucketN[size_t(i)]));
        // Measured across the samples themselves rather than assumed from the
        // packet rate: a stream whose payloads carry different counts (a HERO8
        // alternates 198 and 199 accelerometer samples per second) has a rate
        // that is not any one payload's.
        const double liveSpan = b.lastT - b.firstT;
        b.s.rate = liveSpan > 0 ? double(b.s.samples - 1) / liveSpan : 0.0;
        out.series.push_back(std::move(b.s));
    }
    // By key then component, so two runs over one file list them the same way
    // and a picker does not reorder itself.
    std::sort(out.series.begin(), out.series.end(),
              [](const DataSeries& a, const DataSeries& b) {
                  if (a.key != b.key) return a.key < b.key;
                  return a.component < b.component;
              });

    out.ok = true;
    return out;
}

// ── the same read, on a thread ────────────────────────────────────────────

namespace {

AsyncOpens<DataReading>& reads() {
    static AsyncOpens<DataReading> t;
    return t;
}

} // namespace

uint64_t startDataRead(const MediaInput& in, int streamIndex, int buckets,
                       double timeoutSec) {
    return reads().start(
        [in, streamIndex, buckets](OpenWatch* watch) {
            return readDataStream(in, streamIndex, buckets, watch);
        },
        timeoutSec > 0 ? timeoutSec : kDataReadTimeoutSec);
}

bool dataReadProgress(uint64_t id, DataProgress* out) {
    if (!out) return false;
    AsyncOpens<DataReading>::Slot slot;
    if (!reads().look(id, &slot)) return false;

    out->elapsed = slot.elapsed;
    out->timeout = slot.timeout;
    if (!slot.finished) {
        out->state = DataProgress::State::Reading;
        return true;
    }
    out->result = slot.result;
    out->state = slot.stopped        ? DataProgress::State::Stopped
                 : out->result.ok    ? DataProgress::State::Done
                                     : DataProgress::State::Failed;
    return true;
}

void stopDataRead(uint64_t id) { reads().stop(id); }

void abandonDataRead(uint64_t id) { reads().abandon(id); }

} // namespace ffmpegbro
