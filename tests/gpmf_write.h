// Writing GPMF, so that two things can read the same bytes.
//
// The fixture (`tests/make_fixture.cpp`) needs a `gpmd` payload to put in a
// file; the parser test (`tests/data_test.cpp`) needs the same payload in
// memory to truncate, scribble on and otherwise damage. One builder, because
// two would drift and the test would then be proving something about a payload
// the fixture does not contain.
//
// **This is a writer for the test set and not a general one.** It emits exactly
// the shapes the parser has to get right and nothing else — the point is not to
// be GoPro, it is to put every rule in data_gpmf.h in front of the parser with
// values a test can assert to the last decimal:
//
//   - a **broadcast** `SCAL` (one divisor, three components), which is what an
//     accelerometer has;
//   - a **per-component** `SCAL` (five divisors, five components), which is what
//     `GPS5` has, with five different divisors so that using the wrong one is
//     visible rather than lucky;
//   - a **float under a scale** (`TMPC`), which must come back undivided — the
//     rule that is easiest to get wrong and hardest to notice, because 40.5 °C
//     divided by 100 is 0.405 and looks like a number;
//   - a `SCAL` whose count is **neither one nor the component count**, which
//     must leave its item unscaled and say so;
//   - an item with **repeat 0**, which a HERO8 writes for `FACE` when nobody is
//     in shot and which must advance the cursor rather than loop it;
//   - a **string array** (`UNIT`, five fixed-width slots), which is how a unit
//     per component is written;
//   - and a **complex** item (`?` with a preceding `TYPE`), which must be
//     stepped over by its declared length without being read.
//
// Big-endian everywhere, four-byte aligned, exactly as data_gpmf.h describes.
#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace gpmfw {

using Bytes = std::vector<uint8_t>;

inline void put8(Bytes& b, uint8_t v) { b.push_back(v); }
inline void put16(Bytes& b, uint16_t v) {
    b.push_back(uint8_t(v >> 8));
    b.push_back(uint8_t(v));
}
inline void put32(Bytes& b, uint32_t v) {
    for (int i = 3; i >= 0; --i) b.push_back(uint8_t(v >> (i * 8)));
}
inline void put64(Bytes& b, uint64_t v) {
    for (int i = 7; i >= 0; --i) b.push_back(uint8_t(v >> (i * 8)));
}
inline void putF32(Bytes& b, float v) {
    uint32_t bits;
    std::memcpy(&bits, &v, 4);
    put32(b, bits);
}

/// Pad up to the next four-byte boundary, which every GPMF item is.
inline void pad4(Bytes& b) {
    while (b.size() & 3) b.push_back(0);
}

/// One item: `key | type | struct size | repeat | payload`, padded.
inline void item(Bytes& out, const char* key, char type, uint8_t structSize,
                 uint16_t repeat, const Bytes& payload) {
    out.insert(out.end(), key, key + 4);
    put8(out, uint8_t(type));
    put8(out, structSize);
    put16(out, repeat);
    out.insert(out.end(), payload.begin(), payload.end());
    pad4(out);
}

/// A nested item — the type byte is 0 and the payload is itself GPMF. Written
/// with `structSize` 1 and `repeat` = the byte count, which is what a HERO8
/// writes and is the only encoding that reaches 65535 bytes.
inline void nest(Bytes& out, const char* key, const Bytes& inner) {
    item(out, key, '\0', 1, uint16_t(inner.size()), inner);
}

inline Bytes text(const std::string& s) {
    return Bytes(s.begin(), s.end());
}

/// A `c` item: one string, its declared size being its length.
inline void str(Bytes& out, const char* key, const std::string& s) {
    item(out, key, 'c', uint8_t(s.size()), 1, text(s));
}

/// A `c` item that is an **array** of fixed-width strings, one per component —
/// how `UNIT` says "degrees, degrees, metres, m/s, m/s".
inline void strArray(Bytes& out, const char* key, int width,
                     const std::vector<std::string>& parts) {
    Bytes p;
    for (const std::string& s : parts) {
        for (int i = 0; i < width; ++i)
            p.push_back(i < int(s.size()) ? uint8_t(s[size_t(i)]) : 0);
    }
    item(out, key, 'c', uint8_t(width), uint16_t(parts.size()), p);
}

// ── the payload the fixture and the test share ────────────────────────────

/// How many accelerometer samples one payload carries. 200 a second, which is
/// a HERO8's rate to within one.
inline constexpr int kAcclPerPayload = 200;

/// How many GPS samples. 18 a second, which is a HERO8's.
inline constexpr int kGpsPerPayload = 18;

/// The broadcast divisor: one `SCAL` covering all three accelerometer axes.
inline constexpr int kAcclScale = 100;

/// The temperature written under that divisor, which must come back as itself.
inline constexpr float kTempC = 40.5f;

/// The five `GPS5` divisors, deliberately all different.
inline constexpr int32_t kGpsScale[5] = { 10000000, 10000000, 1000, 1000, 100 };

/// The raw accelerometer numbers for sample `k`, before the divisor.
///
/// Component 1 is **constant** at 981, so a broadcast divisor applied correctly
/// makes it exactly 9.81 m/s² and applied not at all makes it 981 — the cheapest
/// possible assertion that a divisor was found. Components 0 and 2 ramp so that
/// a `min`/`max` folded over every sample has something to be.
inline void acclRaw(int64_t k, int16_t* v) {
    const int16_t r = int16_t(k % 1000);
    v[0] = r;
    v[1] = 981;
    v[2] = int16_t(-r);
}

/// The raw `GPS5` numbers for sample `k`. Latitude and longitude walk; altitude
/// is constant at 123456 raw, which under its own divisor of 1000 is 123.456 m
/// and under the *first* divisor of 10000000 would be 0.0123456 — so an
/// implementation that took divisor[0] for every component fails on this one
/// number alone.
inline void gps5Raw(int64_t k, int32_t* v) {
    v[0] = int32_t(474305352 + k);
    v[1] = int32_t(-1045590902 + k);
    v[2] = 123456;
    v[3] = int32_t((k % 100) * 10);
    v[4] = int32_t((k % 100) * 10);
}

/// One payload — a `DEVC` holding two `STRM`s and the awkward cases.
///
/// `payloadIndex` is which second this is, so the sample values continue across
/// payloads and a test can assert the value at a known moment.
inline Bytes buildPayload(int payloadIndex) {
    Bytes accl;
    {
        Bytes p;
        for (int i = 0; i < kAcclPerPayload; ++i) {
            int16_t v[3];
            acclRaw(int64_t(payloadIndex) * kAcclPerPayload + i, v);
            for (int c = 0; c < 3; ++c) put16(p, uint16_t(v[c]));
        }
        Bytes stmp;
        put64(stmp, uint64_t(payloadIndex) * 1000000ull);
        item(accl, "STMP", 'J', 8, 1, stmp);

        Bytes tsmp;
        put32(tsmp, uint32_t((payloadIndex + 1) * kAcclPerPayload));
        item(accl, "TSMP", 'L', 4, 1, tsmp);

        str(accl, "STNM", "Accelerometer");
        str(accl, "SIUN", "m/s\xb2");

        Bytes scal;
        put16(scal, uint16_t(kAcclScale));
        item(accl, "SCAL", 's', 2, 1, scal);

        // A float **under** that divisor. It must come back as 40.5.
        Bytes tmpc;
        putF32(tmpc, kTempC);
        item(accl, "TMPC", 'f', 4, 1, tmpc);

        item(accl, "ACCL", 's', 6, uint16_t(kAcclPerPayload), p);
    }

    Bytes gps;
    {
        Bytes p;
        for (int i = 0; i < kGpsPerPayload; ++i) {
            int32_t v[5];
            gps5Raw(int64_t(payloadIndex) * kGpsPerPayload + i, v);
            for (int c = 0; c < 5; ++c) put32(p, uint32_t(v[c]));
        }

        Bytes stmp;
        put64(stmp, uint64_t(payloadIndex) * 1000000ull);
        item(gps, "STMP", 'J', 8, 1, stmp);

        Bytes tsmp;
        put32(tsmp, uint32_t((payloadIndex + 1) * kGpsPerPayload));
        item(gps, "TSMP", 'L', 4, 1, tsmp);

        str(gps, "STNM", "GPS (Lat., Long., Alt., 2D speed, 3D speed)");
        strArray(gps, "UNIT", 3, { "deg", "deg", "m", "m/s", "m/s" });

        Bytes scal;
        for (int32_t s : kGpsScale) put32(scal, uint32_t(s));
        item(gps, "SCAL", 'l', 4, 5, scal);

        item(gps, "GPS5", 'l', 20, uint16_t(kGpsPerPayload), p);
    }

    // The awkward stream: a divisor whose count is neither one nor the
    // component count, an item with repeat 0, and a complex type.
    Bytes odd;
    {
        str(odd, "STNM", "Awkward");

        Bytes scal;
        for (int i = 0; i < 2; ++i) put16(scal, 7);
        item(odd, "SCAL", 's', 2, 2, scal);   // two divisors, three components

        Bytes p;
        for (int i = 0; i < 4; ++i)
            for (int c = 0; c < 3; ++c) put16(p, uint16_t(300 + c));
        item(odd, "MISM", 's', 6, 4, p);      // must come back unscaled

        item(odd, "NONE", 'l', 4, 0, {});     // repeat 0: must advance, not loop

        str(odd, "TYPE", "Lff");
        Bytes cx;
        for (int i = 0; i < 2; ++i) { put32(cx, 1); putF32(cx, 2.0f); putF32(cx, 3.0f); }
        item(odd, "CPLX", '?', 12, 2, cx);    // must be stepped over, not read
    }

    Bytes devc;
    Bytes dvid;
    put32(dvid, 1);
    item(devc, "DVID", 'L', 4, 1, dvid);
    str(devc, "DVNM", "ffmpeg-bro fixture");
    nest(devc, "STRM", accl);
    nest(devc, "STRM", gps);
    nest(devc, "STRM", odd);

    Bytes out;
    nest(out, "DEVC", devc);
    return out;
}

} // namespace gpmfw
