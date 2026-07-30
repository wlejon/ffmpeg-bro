// A data stream is packets whose meaning belongs to whatever reads them — so
// this is the thing that reads them, and the thing that says which reader.
//
// Every other stream in this binary is decoded by libavcodec. A data stream
// cannot be: `gpmd`, `tmcd`, `mebx` and `fdsc` all probe as the same
// `bin_data`, because there is no decoder for any of them and libavformat has
// nothing to say beyond "these bytes arrived at this timestamp". What tells one
// from another is the container's **fourcc**, which is why `StreamSummary::tag`
// is the whole identity of such a track (ffmpeg_backend.h) and why it is the
// only thing a copy has to preserve (export_writer.cpp).
//
// So the seam is: **a data stream whose fourcc is X is parsed by the parser
// registered for X.** One row is filled in today — `gpmd`, in data_gpmf.h — and
// a real GoPro file also carries `tmcd`, `fdsc` and sometimes `mebx`, none of
// which has one. That is not a gap to apologise for: those are three different
// formats with three different specifications, and a parser that guessed at one
// would produce numbers nobody could check.
//
// **libav has nothing to ask here, and that is not a breach of the "ask libav"
// convention.** libavformat carries a `gpmd` track, reports its fourcc, and
// hands over its packets; it does not parse the payload, there is no option
// table to enumerate and no `AVCodecDescriptor` to interrogate. Everything
// *around* the parser is still asked — which streams exist, what their tags
// are, when their packets are, which of them a render copies — and only the
// byte layout inside a packet is knowledge this repository owns. It is written
// down in data_gpmf.h with the file it was verified against.
//
// **The payload is untrusted input and the parser is written that way.** See
// data_gpmf.h for what that means in practice; this file's share of it is that
// a reading is bounded before a byte is read: the number of series, the number
// of points kept per series and the total packet bytes admitted are all capped
// here, so a hostile file cannot turn a plot into an allocation.
//
// **What is read, and when.** A whole track, once, on a thread — see
// `startDataRead`. Two facts decided that, and both were measured on a 4.0 GB
// HERO8 file whose `gpmd` track is 4.5 MB over 708 seconds (6.3 kB/s, one
// payload per 1.001 s).
//
// The **size**: that file yields 141 000 accelerometer samples and 40 series, so
// a two-hour recording carries about 45 MB of payload and 1.4 million
// accelerometer samples — which as JS objects would be hundreds of megabytes for
// a plot eight hundred pixels wide. So the answer is *bucketed on the way in* —
// min, max and mean per bucket over a fixed grid, the same shape
// `ui/timeline.js` already draws a waveform from — which makes its size a
// function of the grid rather than of the file. Two hours and twenty seconds of
// telemetry come back the same shape, and only `samples`, `min` and `max` differ,
// because those are folded over every sample rather than over the buckets.
//
// The **time**: 32 ms for that file with every other stream discarded, so about
// a third of a second for two hours. Two frames is already a stutter and a third
// of a second is a freeze, and a URL is unbounded — so it is off the UI thread.
// (Without the discard the same read is 13.3 s: see `readDataStream`.)
#pragma once

#include "ffmpeg_input.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

// ── what a parser produces ────────────────────────────────────────────────

/// One item's samples out of one packet: a quantity, its components, and the
/// numbers, already in the units the format says they are in.
///
/// Format-neutral on purpose. A second parser — `tmcd`, `mebx`, anything —
/// fills this in too, and everything downstream of here (the bucketing, the
/// binding, the lane) works in these terms and never learns which parser ran.
struct DataItem {
    /// What the format calls this quantity. A fourcc for GPMF (`ACCL`), and
    /// whatever names a quantity in another format; used as the series key, so
    /// it has to be stable across packets.
    std::string key;

    /// What it is in words, when the format says — GPMF carries `STNM`
    /// ("Accelerometer"), which is a name out of the *file* rather than a
    /// lookup table here. Empty when it does not.
    std::string name;

    /// The unit of each component, when the format says. One entry per
    /// component, or one entry meaning all of them, or empty.
    std::vector<std::string> units;

    /// How many numbers make one sample. 3 for an accelerometer, 5 for GoPro's
    /// `GPS5`, 1 for a temperature.
    int components = 1;

    /// Samples in this packet, so `values.size() == count * components`.
    int count = 0;

    /// Row-major, sample by sample, **already scaled** into `units`.
    std::vector<double> values;

    /// Whether a divisor was found and applied. Reported rather than assumed,
    /// because a value that should have been divided and was not is the failure
    /// mode that still looks plausible.
    bool scaled = false;
};

/// One packet's worth, plus whatever the packet said about the device it came
/// from and whatever stopped the walk.
struct DataPayload {
    /// The recorder, when the format names it — GPMF's `DVNM` ("HERO8 Black").
    std::string device;

    std::vector<DataItem> items;

    /// Empty when the whole packet parsed. Otherwise **what could not be
    /// trusted and where**, in a sentence — and `items` still holds everything
    /// that parsed *before* it, which is deliberate: a packet truncated by a
    /// camera that lost power has good samples in front of the damage, and
    /// throwing them away would be a second kind of loss on top of the first.
    /// Nothing here is a guess about the bytes that were refused.
    std::string refusal;
};

/// Bytes in, samples out. No libav, no allocation the caller did not ask for,
/// no state between calls — which is what makes a parser fuzzable.
using DataParser = DataPayload (*)(const uint8_t* data, size_t size);

/// The parser for a container fourcc, or null.
///
/// **The dispatch is the fourcc and nothing else**, because the fourcc is all
/// there is: every data stream in every container this build reads probes as
/// `bin_data`. Case-sensitive and exactly four characters, as the container
/// stores it.
DataParser parserForTag(const std::string& tag);

/// Every fourcc that has one, so the UI can offer the affordance exactly where
/// it will work rather than offering it everywhere and failing at the press.
std::vector<std::string> dataParserTags();

// ── what a reading of a whole track is ────────────────────────────────────

/// How many buckets a series is reduced to, unless the caller says otherwise.
///
/// A timeline lane is at most a couple of thousand pixels wide and a plot is
/// less, so two thousand buckets is more resolution than either can draw and
/// leaves headroom for a zoom before the line stops being the data. It is the
/// number that makes a reading's size a property of this constant rather than
/// of the file: two hours of 400 Hz gyroscope and twenty seconds of it produce
/// the same 2000 × 3 buckets, and only the exact `samples`, `min` and `max`
/// differ — those are folded over **every** sample, so the numbers a readout
/// shows are never the decimated ones.
inline constexpr int kDataBuckets = 2000;

/// The most buckets a caller may ask for. A cap because the count arrives from
/// JS and is multiplied by the number of series: without one, "give me a
/// million buckets" is an allocation, not a question.
inline constexpr int kMaxDataBuckets = 20000;

/// The most series one track may produce. Real GPMF from a HERO8 offers
/// twenty-three; the cap is two orders above that so a legitimate file cannot
/// reach it, and a packet loop that invented a fourcc per packet cannot grow
/// the table without bound.
inline constexpr int kMaxDataSeries = 256;

/// The most packet bytes a reading will take in. A HERO8 spends 6.3 kB/s on
/// telemetry, so this is about forty hours of it; what it actually bounds is a
/// file that claims a data track and is one enormous packet. Reaching it stops
/// the read and says so rather than truncating quietly.
inline constexpr int64_t kMaxDataBytes = int64_t(1) << 30;

/// One quantity over the whole track, at the resolution a lane draws.
struct DataSeries {
    std::string key;        ///< `ACCL`
    std::string name;       ///< `Accelerometer`, out of the file
    std::string units;      ///< this component's unit, out of the file
    int component = 0;      ///< which of the item's components this is
    int components = 1;     ///< how many the item had

    /// Exact, over every sample read — not over the buckets.
    int64_t samples = 0;
    double min = 0.0;
    double max = 0.0;

    /// Samples per second, measured across the packets the samples arrived in.
    double rate = 0.0;

    /// Whether the format's own divisor was found and applied to this one.
    bool scaled = false;

    /// The buckets, evenly spaced across [`DataReading::t0`, `t1`). `filled`
    /// is 0 where no sample landed — a gap in the recording is a gap in the
    /// line, and joining across one would draw an interpolation nobody
    /// measured.
    std::vector<float> lo, hi, mean;
    std::vector<uint8_t> filled;
};

/// What one data stream turned out to hold.
struct DataReading {
    bool ok = false;
    std::string error;

    std::string tag;        ///< the fourcc that chose the parser
    std::string device;     ///< what the payload said made it, when it says
    int streamIndex = -1;

    /// The track's own span on the container's clock, which is the clock the
    /// timeline draws on.
    double t0 = 0.0;
    double t1 = 0.0;
    int buckets = 0;

    int64_t packets = 0;    ///< packets read
    int64_t refused = 0;    ///< of them, how many the parser would not finish
    /// The first refusal, with the packet it was in. One rather than a list,
    /// because a damaged track usually damages the same way every time and a
    /// thousand copies of one sentence is not more information.
    std::string refusal;

    std::vector<DataSeries> series;
};

/// Read the whole of one data stream and reduce it to `buckets` per series.
///
/// Synchronous, and **not the call the UI makes** — see `startDataRead`. It is
/// public because it is what the tests exercise and because a headless script
/// with nothing to freeze may as well call it directly.
///
/// `buckets` of zero or less means `kDataBuckets`; more than `kMaxDataBuckets`
/// is refused rather than clamped, because a caller that asked for a million
/// has a bug and a silently smaller answer would hide it.
///
/// **Every other stream is discarded before the first packet.** Without that a
/// 4 GB file is 4 GB of video read and thrown away; with it, libavformat walks
/// the mov index and touches only the data track — measured at **32 ms** for the
/// 4.5 MB `gpmd` track of a 4.0 GB HERO8 file, against **13.3 s** for the same
/// read with the other streams left enabled.
///
/// `watch` is the interrupt callback, so a read of a URL can be stopped. Null
/// when nobody is going to.
DataReading readDataStream(const MediaInput& in, int streamIndex, int buckets,
                           OpenWatch* watch = nullptr);

// ── the same read, on a thread ────────────────────────────────────────────
//
// The reasoning is `probe_async.h`'s, unchanged: the UI thread is the whole
// application, a fifth of a second is twelve frames of a frozen window, and
// this is not `ffmpeg_job.h`'s slot — several readings may be outstanding, one
// must be possible while a render runs, and it writes nothing. The table
// underneath is the same one (`async_open.h`), which is why "a terminal answer
// is handed over exactly once" means the same thing in both places.
//
// **`bro.ffmpeg` is not installed in worker realms**, which is why this is a
// thread here rather than a job for `ui/analyze-worker.js`. That worker does
// the full-file peak and filmstrip decodes off the UI thread through
// `bro.media`, and there is no `bro.ffmpeg` in it to call — so the choice was
// not between two mechanisms but between this one and blocking.

/// How long a read is given when the caller does not say. Longer than a
/// probe's ten seconds, because this one is not waiting for a host to answer:
/// it is reading a whole track, and a 4 GB file off a slow external disk is a
/// legitimate minute.
inline constexpr double kDataReadTimeoutSec = 120.0;

/// Where one read has got to. The same four states a probe has, for the same
/// reason: a stop that was asked for is not a failure, and a caller that
/// pressed the button has to be able to tell.
struct DataProgress {
    enum class State { Reading, Done, Failed, Stopped };
    State state = State::Reading;
    double elapsed = 0.0;
    double timeout = 0.0;
    DataReading result;
};

/// Start one. Returns the id to poll, never zero.
uint64_t startDataRead(const MediaInput& in, int streamIndex, int buckets,
                       double timeoutSec);

/// Where it has got to. False for an id nothing knows about — which, after a
/// terminal answer, is the ordinary case: the answer is handed over once and
/// the entry is forgotten with it.
bool dataReadProgress(uint64_t id, DataProgress* out);

/// Ask it to give up. The interrupt callback reaches libav's read, so this is
/// real rather than a hidden spinner.
void stopDataRead(uint64_t id);

/// Stop it and stop caring — an input removed while its track was still being
/// read. The thread is reaped by whichever call notices it has finished.
void abandonDataRead(uint64_t id);

} // namespace ffmpegbro
