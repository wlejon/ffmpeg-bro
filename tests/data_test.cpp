// A data stream, read: the seam, the parser, and the file the parser is not
// allowed to trust.
//
// Three things are asserted here and they are of different kinds.
//
// **The seam.** A data stream is identified by its fourcc and by nothing else —
// `gpmd`, `tmcd`, `mebx` and `fdsc` all probe as `bin_data` — so the dispatch is
// the tag, one parser is registered for `gpmd`, and a tag with no parser is
// answered by name rather than run through the wrong one. A real GoPro file
// carries three data tracks and only one of them is parseable, which is the
// case this seam exists for.
//
// **The format.** GPMF's rules, each with a value that says the rule was
// followed: a broadcast divisor, a per-component divisor with five different
// numbers in it, a float that must not be divided, a divisor whose count fits
// nothing, an item of repeat zero, a complex type that must be stepped over.
// The fixture is written by `tests/gpmf_write.h`, which is also what builds the
// bytes damaged below, so the two cannot drift apart.
//
// **The file, as an attacker wrote it.** This is the part that matters most.
// Every length, repeat count and nesting depth in a GPMF payload comes from the
// file; a malformed or hostile `.mp4` is the normal case to design for and not
// an edge of it. So a good payload is truncated at **every** four-byte boundary
// in it, every header in it has an oversized length scribbled into it in turn,
// a nesting bomb is built, and a megabyte of pseudo-random bytes is put through
// it — and what is required of each is not that it parses but that it **refuses
// and returns**. A parser that segfaults on a bad file is a worse outcome than a
// camera's telemetry never being plotted, which is what the alternative to
// writing this was.
//
// Usage: ffmpeg-bro-datatest <telemetry-fixture.mp4> [<real-gopro.mp4>]
//
// The second argument is a real camera file if there is one to hand; every
// section that needs it says what it found and is skipped when it is absent,
// which is what keeps this runnable on a machine with no GoPro in the drawer.

#include "data_gpmf.h"
#include "ffmpeg_data.h"
#include "ffmpeg_backend.h"
#include "ffmpeg_input.h"

#include "gpmf_write.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace ffmpegbro;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
    ++checks;
    if (!ok) ++failures;
    std::printf("  %s %s\n", ok ? "ok  " : "FAIL", what.c_str());
}

void checkf(bool ok, const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    check(ok, buf);
}

void section(const char* name) { std::printf("\n== %s ==\n", name); }

bool near(double a, double b, double eps) { return std::fabs(a - b) <= eps; }

const DataSeries* seriesOf(const DataReading& r, const char* key, int comp) {
    for (const DataSeries& s : r.series)
        if (s.key == key && s.component == comp) return &s;
    return nullptr;
}

/// A deterministic PRNG, so that a failure found by the random section can be
/// reproduced exactly. xorshift64* — three lines, no library, same numbers on
/// every platform, which `std::mt19937` with a `random_device` would not be.
struct Rng {
    uint64_t s = 0x9E3779B97F4A7C15ull;
    uint64_t next() {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
        return s * 0x2545F4914F6CDD1Dull;
    }
    uint8_t byte() { return uint8_t(next() >> 33); }
};

/// Every item header's byte offset in a payload, found by the same walk the
/// parser does — used to scribble on each one in turn.
void headerOffsets(const std::vector<uint8_t>& b, size_t off, size_t end,
                   int depth, std::vector<size_t>* out) {
    if (depth > 6) return;
    while (off + 8 <= end) {
        const size_t n = size_t(b[off + 5]) * (size_t(b[off + 6]) << 8 | b[off + 7]);
        if (n > end - (off + 8)) return;
        out->push_back(off);
        if (b[off + 4] == 0) headerOffsets(b, off + 8, off + 8 + n, depth + 1, out);
        off = off + 8 + n + ((4 - (n & 3)) & 3);
    }
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <telemetry-fixture.mp4> [<real-gopro.mp4>]\n",
                     argv[0]);
        return 2;
    }
    const std::string fixture = argv[1];
    const std::string real = argc >= 3 ? argv[2] : std::string();

    // ── the seam ──────────────────────────────────────────────────────────
    section("which parser reads which data stream");
    {
        const std::vector<std::string> tags = dataParserTags();
        check(std::find(tags.begin(), tags.end(), "gpmd") != tags.end(),
              "'gpmd' has a parser registered for it");
        check(parserForTag("gpmd") != nullptr, "and the registry hands it over");
        // The three other data tracks a real GoPro file carries. None of them
        // is GPMF and none may be run through a GPMF parser.
        check(parserForTag("tmcd") == nullptr, "'tmcd' — a timecode track — has none");
        check(parserForTag("fdsc") == nullptr, "'fdsc' has none");
        check(parserForTag("mebx") == nullptr, "'mebx' — Apple's timed metadata — has none");
        check(parserForTag("") == nullptr, "and a stream with no fourcc has none, "
                                           "since the fourcc is the whole question");
        check(parserForTag("GPMD") == nullptr,
              "the match is the tag exactly as the container stores it, not a "
              "case-folded one");
    }

    // ── the format ────────────────────────────────────────────────────────
    section("what GPMF says, read back");
    const std::vector<uint8_t> good = gpmfw::buildPayload(0);
    {
        const DataPayload p = readGpmfPayload(good.data(), good.size());
        check(p.refusal.empty(), "a well-formed payload parses with nothing refused");
        checkf(p.device == "ffmpeg-bro fixture",
               "the device names itself out of the payload: '%s'", p.device.c_str());

        const DataItem* accl = nullptr;
        const DataItem* gps = nullptr;
        const DataItem* tmpc = nullptr;
        const DataItem* mism = nullptr;
        for (const DataItem& i : p.items) {
            if (i.key == "ACCL") accl = &i;
            if (i.key == "GPS5") gps = &i;
            if (i.key == "TMPC") tmpc = &i;
            if (i.key == "MISM") mism = &i;
        }

        check(accl != nullptr, "the accelerometer item is there");
        if (accl) {
            checkf(accl->components == 3 && accl->count == gpmfw::kAcclPerPayload,
                   "with 3 components and %d samples (struct size over element "
                   "size is the component count)", accl->count);
            checkf(accl->name == "Accelerometer",
                   "named out of the file's own STNM rather than a table here: '%s'",
                   accl->name.c_str());
            check(accl->scaled, "and a divisor was found for it");
            // **The broadcast divisor.** Component 1 is a constant 981 raw; one
            // divisor of 100 covering all three components makes it 9.81, and
            // no divisor at all makes it 981.
            const double g = accl->values[1];
            checkf(near(g, 9.81, 1e-9),
                   "one SCAL covering three components divides all of them: 981/100 "
                   "= %.6f", g);
            // **As UTF-8.** The fixture writes the unit the way a HERO8 does,
            // which is ISO-8859-1's 0xB2 for the superscript two, and the parser
            // transcodes anything that is not already UTF-8 (see `textAt`).
            // Written as the two bytes rather than as a literal, so what this
            // asserts does not depend on the encoding of this source file.
            check(accl->units.size() == 1 && accl->units[0] == "m/s\xc2\xb2",
                  "and the unit comes out of SIUN, transcoded to UTF-8");
        }

        check(gps != nullptr, "the GPS item is there");
        if (gps) {
            checkf(gps->components == 5 && gps->count == gpmfw::kGpsPerPayload,
                   "with 5 components and %d samples", gps->count);
            check(gps->scaled, "and a divisor was found for it");
            // **The per-component divisor.** Five different numbers, and the
            // altitude is the one that catches an implementation using
            // divisor[0] for everything: 123456/1000 is 123.456 m, and
            // 123456/10000000 is 0.0123456.
            checkf(near(gps->values[0], 47.4305352, 1e-7),
                   "latitude 474305352 / 10000000 = %.7f", gps->values[0]);
            checkf(near(gps->values[2], 123.456, 1e-9),
                   "altitude 123456 / **1000** = %.4f, which is the component's own "
                   "divisor and not the first one", gps->values[2]);
            check(gps->units.size() == 5 && gps->units[0] == "deg" &&
                      gps->units[2] == "m" && gps->units[4] == "m/s",
                  "and UNIT is read as one fixed-width string per component");
        }

        // **The rule that is easiest to get wrong.** TMPC is a float32 written
        // *after* the accelerometer's SCAL and inside its scope. A divisor
        // undoes a fixed-point encoding, and a float was not encoded that way.
        check(tmpc != nullptr, "the temperature is there");
        if (tmpc) {
            checkf(near(tmpc->values[0], double(gpmfw::kTempC), 1e-5),
                   "a float under a SCAL of 100 comes back as %.4f and not %.6f — a "
                   "divisor undoes a fixed point, and a float has none",
                   tmpc->values[0], double(gpmfw::kTempC) / gpmfw::kAcclScale);
            check(!tmpc->scaled, "and it says it was not scaled");
        }

        // A divisor whose count is neither 1 nor the component count.
        check(mism != nullptr, "the item with an unusable SCAL is there");
        if (mism) {
            check(!mism->scaled,
                  "two divisors for three components is not resolved by taking the "
                  "first: the item is left alone");
            checkf(near(mism->values[0], 300.0, 1e-9),
                   "so its numbers are the raw ones (%.1f)", mism->values[0]);
        }

        bool sawNone = false, sawComplex = false;
        for (const DataItem& i : p.items) {
            if (i.key == "NONE") sawNone = true;
            if (i.key == "CPLX") sawComplex = true;
        }
        check(!sawNone, "an item of repeat 0 yields no samples — and the walk got "
                        "past it, which is what the items after it prove");
        check(!sawComplex,
              "a '?' complex item is stepped over by its declared length rather "
              "than read: a record of an id and six floats is not one line on a plot");
    }

    // ── the file, as an attacker wrote it ─────────────────────────────────
    //
    // Nothing below asserts a *value*. What each asserts is that the call
    // returned at all, read nothing outside the buffer it was given, and — where
    // the damage is unambiguous — said what it found.
    section("a payload this parser is not allowed to trust");
    {
        // Empty and near-empty.
        check(readGpmfPayload(nullptr, 0).items.empty(), "a null payload is nothing");
        check(readGpmfPayload(good.data(), 0).items.empty(), "an empty payload is nothing");
        for (size_t n = 1; n < 8; ++n) {
            const DataPayload p = readGpmfPayload(good.data(), n);
            check(p.items.empty() && !p.refusal.empty(),
                  "a payload shorter than one header is refused (" +
                      std::to_string(n) + " bytes)");
        }

        // **Truncated at every four-byte boundary.** A camera that lost power
        // mid-write leaves exactly this, and it is also the cheapest way to
        // reach every "declares more than is present" branch in the walk.
        int truncRefused = 0, truncClean = 0;
        for (size_t n = 8; n < good.size(); n += 4) {
            const DataPayload p = readGpmfPayload(good.data(), n);
            if (p.refusal.empty()) ++truncClean; else ++truncRefused;
            // Whatever survived has to be internally consistent, or the caller
            // would index off the end of it.
            for (const DataItem& i : p.items) {
                if (i.values.size() != size_t(i.count) * size_t(i.components)) {
                    check(false, "a truncated payload produced an inconsistent item");
                    n = good.size();
                    break;
                }
            }
        }
        checkf(truncRefused + truncClean == int((good.size() - 8 + 3) / 4),
               "truncated at every 4-byte boundary: %d refused, %d ended cleanly, "
               "none crashed", truncRefused, truncClean);
        check(truncRefused > 0,
              "and cutting a payload mid-item is refused rather than parsed on");

        // **An oversized length in every header in turn.** The declared size and
        // the declared repeat are separate bytes and are scribbled separately,
        // because a check on the product that trusted either one would pass one
        // of these and fail the other.
        std::vector<size_t> heads;
        headerOffsets(good, 0, good.size(), 0, &heads);
        checkf(heads.size() > 8, "the good payload has %zu item headers in it",
               heads.size());
        int refusedSize = 0, refusedRepeat = 0;
        for (size_t h : heads) {
            {
                std::vector<uint8_t> bad = good;
                bad[h + 5] = 0xFF;    // struct size
                const DataPayload p = readGpmfPayload(bad.data(), bad.size());
                if (!p.refusal.empty()) ++refusedSize;
            }
            {
                std::vector<uint8_t> bad = good;
                bad[h + 6] = 0xFF;    // repeat, high byte
                bad[h + 7] = 0xFF;
                const DataPayload p = readGpmfPayload(bad.data(), bad.size());
                if (!p.refusal.empty()) ++refusedRepeat;
            }
        }
        checkf(refusedSize > 0 && refusedRepeat > 0,
               "an oversized length in a header is refused: %d of %zu by struct "
               "size, %d of %zu by repeat count",
               refusedSize, heads.size(), refusedRepeat, heads.size());

        // **A length that overflows the product.** 255 × 65535 is 16.7 MB, which
        // is the largest a header can declare — put in front of a 2 KB buffer it
        // is the plainest possible lie about what is there.
        {
            std::vector<uint8_t> bad = good;
            bad[5] = 0xFF; bad[6] = 0xFF; bad[7] = 0xFF;
            const DataPayload p = readGpmfPayload(bad.data(), bad.size());
            checkf(!p.refusal.empty(),
                   "the largest length a header can express, over a 2 KB payload, is "
                   "refused: %s", p.refusal.c_str());
        }

        // **A nesting bomb.** Each level is a nested item whose payload is the
        // next; the parser has to stop at its own depth cap rather than at the
        // C stack's.
        {
            std::vector<uint8_t> inner;
            for (int d = 0; d < 200; ++d) {
                gpmfw::Bytes wrapped;
                gpmfw::nest(wrapped, "DEVC", inner);
                inner = wrapped;
            }
            const DataPayload p = readGpmfPayload(inner.data(), inner.size());
            checkf(!p.refusal.empty() &&
                       p.refusal.find("nested deeper") != std::string::npos,
                   "200 levels of nesting is refused at the depth cap: %s",
                   p.refusal.c_str());
        }

        // **An item that claims to be nested and is empty**, repeated — the
        // shape that loops a walk which advances by the payload rather than by
        // the header.
        {
            std::vector<uint8_t> zeros(4096, 0);
            const DataPayload p = readGpmfPayload(zeros.data(), zeros.size());
            check(p.items.empty(),
                  "4 KB of zero bytes — every item nested, empty, and named with "
                  "NULs — terminates and yields nothing");
        }

        // **Pseudo-random bytes.** Not a fuzzer, but the cheapest possible one:
        // a megabyte of noise reaches type characters, repeat counts and nesting
        // combinations nothing above thought of.
        {
            Rng rng;
            int refused = 0;
            const auto began = std::chrono::steady_clock::now();
            for (int round = 0; round < 200; ++round) {
                std::vector<uint8_t> noise(5000);
                for (uint8_t& b : noise) b = rng.byte();
                const DataPayload p = readGpmfPayload(noise.data(), noise.size());
                if (!p.refusal.empty()) ++refused;
                for (const DataItem& i : p.items)
                    if (i.values.size() != size_t(i.count) * size_t(i.components)) {
                        check(false, "random bytes produced an inconsistent item");
                        round = 200;
                        break;
                    }
            }
            const double ms = std::chrono::duration<double, std::milli>(
                                  std::chrono::steady_clock::now() - began).count();
            checkf(true, "1 MB of pseudo-random bytes in 200 packets: %d refused, "
                         "%.1f ms, no crash and nothing inconsistent", refused, ms);
        }

        // **A good payload with one byte changed, everywhere.** The slowest of
        // these and the one most likely to find something the others reasoned
        // around, so it is run over the first kilobyte rather than all of it.
        {
            int refused = 0, parsed = 0;
            const size_t upTo = std::min<size_t>(good.size(), 1024);
            for (size_t i = 0; i < upTo; ++i) {
                for (uint8_t bit : { uint8_t(0x01), uint8_t(0x80), uint8_t(0xFF) }) {
                    std::vector<uint8_t> bad = good;
                    bad[i] = uint8_t(bad[i] ^ bit);
                    const DataPayload p = readGpmfPayload(bad.data(), bad.size());
                    if (p.refusal.empty()) ++parsed; else ++refused;
                    for (const DataItem& it : p.items)
                        if (it.values.size() != size_t(it.count) * size_t(it.components)) {
                            check(false, "a one-byte change produced an inconsistent item");
                            i = upTo;
                            break;
                        }
                }
            }
            checkf(true, "every byte of the first KB flipped three ways (%d cases): "
                         "%d parsed, %d refused, no crash",
                   parsed + refused, parsed, refused);
        }
    }

    // ── the whole track, out of a file ────────────────────────────────────
    section("a data track read out of the telemetry fixture");
    {
        MediaInput in;
        in.path = fixture;
        const ProbeResult probe = probeMedia(in);
        if (!probe.ok) {
            std::printf("  -- skipped: %s will not open (%s)\n", fixture.c_str(),
                        probe.error.c_str());
        } else {
            int dataIndex = -1;
            std::string tag;
            for (const StreamSummary& s : probe.streams)
                if (s.kind == "data" && s.tag == "gpmd") { dataIndex = s.index; tag = s.tag; }
            checkf(dataIndex >= 0, "the fixture carries a gpmd track (stream %d)",
                   dataIndex);

            if (dataIndex >= 0) {
                const auto began = std::chrono::steady_clock::now();
                const DataReading r = readDataStream(in, dataIndex, 0);
                const double ms = std::chrono::duration<double, std::milli>(
                                      std::chrono::steady_clock::now() - began).count();
                checkf(r.ok, "and it reads (%s)", r.ok ? "ok" : r.error.c_str());
                if (r.ok) {
                    checkf(true, "  %lld packets, %zu series, %.1f ms",
                           static_cast<long long>(r.packets), r.series.size(), ms);
                    check(r.refused == 0, "with no packet the parser would not finish");
                    check(r.device == "ffmpeg-bro fixture",
                          "the device out of the payload reaches the reading");
                    checkf(r.buckets == kDataBuckets,
                           "reduced to %d buckets a series, which is what makes the "
                           "answer's size a property of this number and not of the "
                           "file", r.buckets);

                    const DataSeries* g = seriesOf(r, "ACCL", 1);
                    check(g != nullptr, "the accelerometer's second axis is a series");
                    if (g) {
                        checkf(near(g->min, 9.81, 1e-6) && near(g->max, 9.81, 1e-6),
                               "whose min and max are both 9.81 — folded over every "
                               "sample, not over the buckets (%.6f..%.6f)",
                               g->min, g->max);
                        checkf(g->units == "m/s\xc2\xb2" && g->name == "Accelerometer",
                               "named and united out of the file ('%s', '%s')",
                               g->name.c_str(), g->units.c_str());
                        checkf(near(g->rate, double(gpmfw::kAcclPerPayload), 3.0),
                               "at a measured %.1f samples a second", g->rate);
                    }

                    const DataSeries* alt = seriesOf(r, "GPS5", 2);
                    check(alt != nullptr, "the GPS altitude is a series");
                    if (alt)
                        checkf(near(alt->min, 123.456, 1e-4) && near(alt->max, 123.456, 1e-4),
                               "at 123.456 m throughout, which is its own divisor and "
                               "not the first one (%.4f..%.4f)", alt->min, alt->max);

                    const DataSeries* t = seriesOf(r, "TMPC", 0);
                    if (t)
                        checkf(near(t->min, double(gpmfw::kTempC), 1e-4),
                               "and the temperature is %.2f rather than %.4f",
                               t->min, double(gpmfw::kTempC) / gpmfw::kAcclScale);

                    // A bucket nothing landed in is a gap, not a zero: joining a
                    // line across one would draw an interpolation nobody measured.
                    const DataSeries* any = r.series.empty() ? nullptr : &r.series[0];
                    if (any) {
                        int filled = 0;
                        for (uint8_t f : any->filled) filled += f ? 1 : 0;
                        checkf(filled > 0 && filled <= r.buckets,
                               "%d of %d buckets carry a sample; the rest are marked "
                               "empty rather than zero", filled, r.buckets);
                    }
                }

                // The refusals the call itself owes.
                const DataReading tooMany = readDataStream(in, dataIndex,
                                                           kMaxDataBuckets + 1);
                check(!tooMany.ok, "a reading of more buckets than the cap is refused "
                                   "rather than clamped");
                const DataReading noStream = readDataStream(in, 99, 0);
                check(!noStream.ok, "and so is a stream index the file does not have");
            }

            // The other streams in the file have no parser and are told so by
            // name — this is the seam from the file's end.
            for (const StreamSummary& s : probe.streams) {
                if (s.kind == "data" || s.index == dataIndex) continue;
                const DataReading r = readDataStream(in, s.index, 0);
                if (!r.ok && r.error.find("parses") != std::string::npos) {
                    checkf(true, "stream %d (%s) is refused by name: %s", s.index,
                           s.codec.c_str(), r.error.c_str());
                    break;
                }
            }
        }
    }

    // ── a real camera file, when there is one ─────────────────────────────
    section("a real camera file");
    if (real.empty()) {
        std::printf("  -- skipped: no camera file given. Everything above is the "
                    "fixture, which is written by this repository and therefore "
                    "cannot prove a real HERO8 payload parses; pass one as the "
                    "second argument to check that it does.\n");
    } else {
        MediaInput in;
        in.path = real;
        const ProbeResult probe = probeMedia(in);
        if (!probe.ok) {
            std::printf("  -- skipped: %s will not open (%s)\n", real.c_str(),
                        probe.error.c_str());
        } else {
            int parseable = 0, index = -1;
            std::string others;
            for (const StreamSummary& s : probe.streams) {
                if (s.kind != "data") continue;
                if (parserForTag(s.tag)) { ++parseable; if (index < 0) index = s.index; }
                else { if (!others.empty()) others += ", "; others += s.tag; }
            }
            // **Skipped rather than failed**, which is the property every suite
            // here has: a camera file with the telemetry switched off, or an
            // older camera, carries a `tmcd` and nothing else — and "this file
            // has no data track a parser answers for" is a true thing about the
            // file rather than a fault in the code. What *is* asserted is the
            // seam itself, and the seam is as visible here as it would be with a
            // `gpmd` present: the tags that got no parser are named.
            if (!parseable) {
                const std::string had = others.empty() ? std::string()
                                                       : " (it has " + others + ")";
                std::printf("  -- skipped: %s carries no data track anything here "
                            "parses%s. That is the seam working, not failing.\n",
                            real.c_str(), had.c_str());
            } else {
                checkf(true, "it carries %d parseable data track(s)%s%s — which is the "
                             "case the seam exists for", parseable,
                       others.empty() ? "" : " beside ", others.c_str());
            }
            if (index >= 0) {
                const auto began = std::chrono::steady_clock::now();
                const DataReading r = readDataStream(in, index, 0);
                const double ms = std::chrono::duration<double, std::milli>(
                                      std::chrono::steady_clock::now() - began).count();
                checkf(r.ok, "and it reads (%s)", r.ok ? "ok" : r.error.c_str());
                if (r.ok) {
                    checkf(true, "  '%s': %lld packets, %lld refused, %zu series, "
                                 "%.0f ms", r.device.c_str(),
                           static_cast<long long>(r.packets),
                           static_cast<long long>(r.refused), r.series.size(), ms);
                    for (const DataSeries& s : r.series)
                        std::printf("    %s/%d %-34s %-6s %8lld samples  %7.1f Hz  "
                                    "%12.4f .. %12.4f%s\n",
                                    s.key.c_str(), s.component, s.name.c_str(),
                                    s.units.c_str(),
                                    static_cast<long long>(s.samples), s.rate,
                                    s.min, s.max, s.scaled ? "" : "  (unscaled)");
                    check(r.refused == 0, "with no packet the parser would not finish");

                    // Gravity is the one number in a real file that can be
                    // checked without knowing where the camera was: whatever a
                    // camera is doing, the magnitude of its accelerometer over a
                    // whole recording averages near 9.8 m/s², and it does so only
                    // if the broadcast divisor was applied.
                    const DataSeries* a0 = seriesOf(r, "ACCL", 0);
                    const DataSeries* a1 = seriesOf(r, "ACCL", 1);
                    const DataSeries* a2 = seriesOf(r, "ACCL", 2);
                    if (a0 && a1 && a2) {
                        const double reach = std::max({ std::fabs(a0->min), std::fabs(a0->max),
                                                        std::fabs(a1->min), std::fabs(a1->max),
                                                        std::fabs(a2->min), std::fabs(a2->max) });
                        checkf(reach > 1.0 && reach < 500.0,
                               "the accelerometer reaches %.2f m/s², which is a number "
                               "an accelerometer has — undivided it would be in the "
                               "hundreds of thousands", reach);
                    }
                    const DataSeries* lat = seriesOf(r, "GPS5", 0);
                    if (lat)
                        checkf(lat->min >= -90.0 && lat->max <= 90.0,
                               "and latitude is %.5f..%.5f, which is on the Earth — "
                               "undivided it would be in the hundreds of millions",
                               lat->min, lat->max);
                }
            }
        }
    }

    std::printf("\n%d checks, %d failed\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
