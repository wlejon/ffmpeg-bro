// The GPMF walk. See data_gpmf.h for the format and for why every read here is
// checked against the bytes that are actually present.

#include "data_gpmf.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace ffmpegbro {

namespace {

// ── the type alphabet ─────────────────────────────────────────────────────
//
// This *is* written out, because it is the format's own alphabet and there is
// nothing to ask: a type is one ASCII character and the mapping to a width is
// the specification. A character this does not know is not guessed at — the
// item is skipped by the length its header declares, which keeps the walk in
// step without inventing a number.

/// Bytes one element of this type occupies, or 0 for "not a number this reads".
int widthOf(char t) {
    switch (t) {
        case 'b': case 'B': case 'c': return 1;   // int8, uint8, char
        case 's': case 'S': return 2;             // int16, uint16
        case 'l': case 'L': case 'f': return 4;   // int32, uint32, float32
        case 'q': return 4;                       // Q15.16 fixed point
        case 'j': case 'J': case 'd': return 8;   // int64, uint64, float64
        case 'Q': return 8;                       // Q31.32 fixed point
        case 'F': return 4;                       // a fourcc
        case 'G': return 16;                      // a UUID
        case 'U': return 1;                       // a UTC date string
        default: return 0;                        // '?' complex, or unknown
    }
}

/// Is this type a number worth plotting? `c`, `U`, `F` and `G` are text or
/// identity; `?` is a record described by a preceding `TYPE`, which is a row
/// rather than a value — a face box has an id and six floats and no reading of
/// it is one line on a chart. Refused here by kind rather than by key, so a
/// format revision that adds another complex quantity is refused the same way.
bool isNumeric(char t) {
    switch (t) {
        case 'b': case 'B': case 's': case 'S': case 'l': case 'L':
        case 'j': case 'J': case 'f': case 'd': case 'q': case 'Q':
            return true;
        default:
            return false;
    }
}

/// Whether a divisor may touch this type. Integers only — see the SCAL section
/// of data_gpmf.h for the measurement that settled it.
bool isFixedPoint(char t) {
    switch (t) {
        case 'b': case 'B': case 's': case 'S': case 'l': case 'L':
        case 'j': case 'J':
            return true;
        default:
            return false;
    }
}

// Big-endian readers. Taken a byte at a time rather than by a load-and-swap,
// because the payload has no alignment guarantee at all: an item's body starts
// eight bytes past a four-byte boundary, which is aligned for a uint32 and not
// for a uint64, and a misaligned load is undefined before it is slow.
uint16_t be16(const uint8_t* p) { return uint16_t(p[0]) << 8 | p[1]; }
uint32_t be32(const uint8_t* p) {
    return uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3];
}
uint64_t be64(const uint8_t* p) { return uint64_t(be32(p)) << 32 | be32(p + 4); }

double valueAt(const uint8_t* p, char t) {
    switch (t) {
        case 'b': return double(int8_t(p[0]));
        case 'B': return double(p[0]);
        case 's': return double(int16_t(be16(p)));
        case 'S': return double(be16(p));
        case 'l': return double(int32_t(be32(p)));
        case 'L': return double(be32(p));
        case 'j': return double(int64_t(be64(p)));
        case 'J': return double(be64(p));
        // A bit pattern reinterpreted, not a conversion — `memcpy` because a
        // cast through a pointer is the strict-aliasing violation every
        // compiler is allowed to miscompile.
        case 'f': { float v; uint32_t bits = be32(p); std::memcpy(&v, &bits, 4); return double(v); }
        case 'd': { double v; uint64_t bits = be64(p); std::memcpy(&v, &bits, 8); return v; }
        case 'q': return double(int32_t(be32(p))) / 65536.0;
        case 'Q': return double(int64_t(be64(p))) / 4294967296.0;
        default:  return 0.0;
    }
}

// ── the structural vocabulary ─────────────────────────────────────────────

/// The keys that describe rather than measure. See data_gpmf.h for why this is
/// written out, why it cannot be complete, and why an omission costs a row on a
/// picker and never a wrong number.
///
/// Every entry has been seen doing description work in a real HERO8 payload:
/// the first group is per-stream description (`STRM`'s own metadata), the
/// second is per-device (`DEVC`'s), and `DEVC`/`STRM` themselves are the
/// containers. `EMPT` is GPMF's own gap marker — samples that did not arrive —
/// and is description of an absence rather than a measurement of one.
bool isStructure(const char* k) {
    static const char* const KNOWN_STRUCTURE[] = {
        // containers
        "DEVC", "STRM",
        // per-stream description
        "STMP", "TSMP", "STNM", "SCAL", "SIUN", "UNIT", "TYPE",
        "MTRX", "ORIN", "ORIO", "EMPT", "TIMO", "TICK", "TOCK",
        // per-device description
        "DVID", "DVNM", "VERS", "FMWR", "LINF", "CINF", "CASN", "MINF",
        "MUID", "MTYP",
    };
    for (const char* s : KNOWN_STRUCTURE)
        if (std::strncmp(k, s, 4) == 0) return true;
    return false;
}

/// Are these bytes already UTF-8?
///
/// The question `textAt` has to answer, and it is decidable rather than a guess:
/// UTF-8 is a prefix code with a fixed shape, so a byte sequence either is one
/// or is not.
bool isUtf8(const uint8_t* p, size_t n) {
    for (size_t i = 0; i < n;) {
        const uint8_t c = p[i];
        int extra = 0;
        if (c < 0x80) extra = 0;
        else if ((c & 0xE0) == 0xC0) extra = 1;
        else if ((c & 0xF0) == 0xE0) extra = 2;
        else if ((c & 0xF8) == 0xF0) extra = 3;
        else return false;
        if (extra && i + size_t(extra) >= n) return false;
        for (int k = 1; k <= extra; ++k)
            if ((p[i + size_t(k)] & 0xC0) != 0x80) return false;
        i += size_t(extra) + 1;
    }
    return true;
}

/// A `c`/`U` payload as text, stopping at the first NUL. GPMF pads a string up
/// to its declared size with NULs, and a unit array is several fixed-width
/// strings in a row — `deg`, `deg`, `m\0\0`, `m/s`, `m/s` for `GPS5` — so this
/// takes one slot rather than the whole payload.
///
/// **The encoding is not declared and has to be decided.** GPMF calls `c` a
/// "single byte character string" and says nothing about what a byte over 0x7F
/// means; a HERO8 writes an accelerometer's unit as `m/s` followed by 0xB2,
/// which is ISO-8859-1's superscript two and is not valid UTF-8. Handed on
/// unchanged it reaches QuickJS as a broken string and is replaced character by
/// character, so the unit on a lane reads `m/s?` -- a fact about the file lost
/// to an encoding nobody stated.
///
/// So: **valid UTF-8 is kept and anything else is read as Latin-1.** That is
/// decidable rather than a guess (`isUtf8` above), it is right for both of the
/// two things a camera actually writes, and the one case it gets wrong is a file
/// whose Latin-1 bytes happen to form a valid UTF-8 sequence -- which for the
/// degree sign and the superscripts that appear in units cannot happen, because
/// those are single bytes in the 0xA0-0xBF range and UTF-8 never starts a
/// sequence there.
std::string textAt(const uint8_t* p, size_t n) {
    size_t len = 0;
    while (len < n && p[len] != 0) ++len;
    if (isUtf8(p, len)) return std::string(reinterpret_cast<const char*>(p), len);
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        const uint8_t c = p[i];
        if (c < 0x80) {
            out.push_back(char(c));
        } else {
            out.push_back(char(0xC0 | (c >> 6)));
            out.push_back(char(0x80 | (c & 0x3F)));
        }
    }
    return out;
}

/// What is in scope inside one nested level. Reset on every recursion, which is
/// what stops one `STRM`'s divisor and units reaching the next one.
struct Scope {
    std::vector<double> scal;
    std::vector<std::string> units;
    std::string name;
};

/// One item this level produced, and how many samples it carried — kept so that
/// the level's description can be given to the right one when the level ends.
struct Produced {
    size_t index;   ///< into the payload's item list
    size_t repeat;
};

/// Hand `STNM`, `SIUN` and `UNIT` to the item they are about.
///
/// **They describe a stream's *sample data*, and a stream carries other items
/// beside it.** A HERO8's accelerometer stream is `STNM` "Accelerometer",
/// `SIUN` "m/s²", `SCAL` 417, then `TMPC` and then `ACCL` — and the name and the
/// unit belong to `ACCL`. Handing them to everything in the level is what makes
/// a camera's temperature come back labelled "Accelerometer" and measured in
/// m/s², which is a quiet lie of exactly the kind a plot would draw.
///
/// Which item they belong to is not written down anywhere. What the format
/// gives instead is `TSMP`, the stream's cumulative sample count, which in every
/// payload of every real file measured equals the running sum of exactly one
/// item's repeat counts — so within one payload that item is the one with the
/// **largest repeat**, and that is the rule. A tie gives the description to
/// both, which is the honest answer to two items that are equally the stream's.
///
/// The cost of getting it wrong is bounded and one-directional: a name and a
/// unit on the wrong row of a picker, never a wrong *number*. The divisor is
/// decided separately and by type, precisely so that the two cannot fail
/// together.
void describe(std::vector<DataItem>& items, const std::vector<Produced>& mine,
              const Scope& scope) {
    size_t most = 0;
    for (const Produced& p : mine) most = std::max(most, p.repeat);
    if (most == 0) return;
    for (const Produced& p : mine) {
        if (p.repeat != most) continue;
        items[p.index].name = scope.name;
        items[p.index].units = scope.units;
    }
}

/// The walk's shared budget. The caps are per *packet* rather than per level,
/// so a file cannot get round one of them by nesting.
struct Budget {
    int64_t items = 0;
    int64_t values = 0;
    /// Set by a cap, never by a length. The two kinds of refusal end different
    /// amounts of the walk — see `refuse` and `halt`.
    bool stopped = false;
    std::string* refusal = nullptr;
    std::string* device = nullptr;
    std::vector<DataItem>* out = nullptr;

    /// Records the first refusal only. A damaged track usually damages the same
    /// way in every packet, and the caller counts them; a thousand copies of
    /// one sentence is not more information than one.
    void refuse(const std::string& what) {
        if (refusal->empty()) *refusal = what;
    }

    /// A refusal that ends the whole packet rather than one level of it. The
    /// caps are the packet's, so once one is reached there is nothing further
    /// to read anywhere in it.
    void halt(const std::string& what) { refuse(what); stopped = true; }
};

std::string at(size_t off) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), " at byte %zu", off);
    return buf;
}

void walk(const uint8_t* base, size_t off, size_t end, int depth, Budget& b) {
    if (depth >= kGpmfMaxDepth) {
        b.halt("nested deeper than " + std::to_string(kGpmfMaxDepth) +
               " levels" + at(off));
        return;
    }
    Scope scope;
    std::vector<Produced> mine;

    // `off + 8 <= end` and not `off < end`: a trailing fragment shorter than a
    // header is the ordinary end of a padded payload, not damage, and asking
    // for eight bytes before reading eight bytes is the whole of the bounds
    // check on the header itself.
    while (off + 8 <= end) {
        const uint8_t* h = base + off;
        const char* key = reinterpret_cast<const char*>(h);
        const char type = char(h[4]);
        const size_t structSize = h[5];
        const size_t repeat = be16(h + 6);
        const size_t body = off + 8;
        // At most 255 × 65535 = 16 711 425, so this cannot overflow a size_t on
        // any machine this builds for; it is written as size_t arithmetic
        // anyway so that the check below is a comparison and not a subtraction
        // that could wrap.
        const size_t n = structSize * repeat;

        // The one check the whole file rests on: what the header *declares* is
        // compared against what is *there*, and a subtraction that could wrap
        // is avoided by comparing rather than adding.
        if (n > end - body) {
            b.refuse("an item declares " + std::to_string(n) + " bytes with only " +
                     std::to_string(end - body) + " left" + at(off));
            return;
        }
        if (++b.items > kGpmfMaxItems) {
            b.halt("more than " + std::to_string(kGpmfMaxItems) + " items" + at(off));
            return;
        }

        if (type == '\0') {
            // Nested. Bounded to this item's own payload, so a child cannot
            // read past its parent however it is written. A child that refused
            // does **not** end this level: this item's length was checked
            // against this level's end before the recursion, so the cursor is
            // still where the parent's own header says it is, and the streams
            // after a damaged one are as readable as they ever were. Only a cap
            // — which belongs to the packet rather than to a level — halts
            // everything.
            walk(base, body, body + n, depth + 1, b);
            if (b.stopped) return;
        } else if (std::strncmp(key, "SCAL", 4) == 0) {
            scope.scal.clear();
            const int w = widthOf(type);
            // Taken as `structSize / w` divisors per repeat rather than one
            // per repeat: a HERO8 writes five int32s as five repeats of one,
            // and nothing in the format stops a writer putting them in one
            // struct of five. Both are the same five numbers.
            if (w > 0 && isNumeric(type) && structSize % size_t(w) == 0) {
                for (size_t i = 0; i < n / size_t(w); ++i)
                    scope.scal.push_back(valueAt(base + body + i * size_t(w), type));
            }
            // A divisor this cannot read leaves the scope empty, so what
            // follows is reported unscaled rather than divided by a guess.
        } else if (std::strncmp(key, "SIUN", 4) == 0 ||
                   std::strncmp(key, "UNIT", 4) == 0) {
            // One fixed-width string per component, or one for all of them.
            scope.units.clear();
            if (structSize > 0)
                for (size_t i = 0; i < repeat; ++i)
                    scope.units.push_back(textAt(base + body + i * structSize, structSize));
        } else if (std::strncmp(key, "STNM", 4) == 0) {
            scope.name = textAt(base + body, n);
        } else if (std::strncmp(key, "DVNM", 4) == 0) {
            if (b.device->empty()) *b.device = textAt(base + body, n);
        } else if (isNumeric(type) && !isStructure(key)) {
            const int w = widthOf(type);
            const int comps = (w > 0 && structSize % size_t(w) == 0)
                                  ? int(structSize / size_t(w)) : 0;
            if (comps > 0 && repeat > 0) {
                const size_t total = size_t(comps) * repeat;
                if (b.values + int64_t(total) > kGpmfMaxValues) {
                    b.halt("more than " + std::to_string(kGpmfMaxValues) +
                           " values in one packet" + at(off));
                    return;
                }
                b.values += int64_t(total);

                DataItem item;
                item.key.assign(key, 4);
                item.components = comps;
                item.count = int(repeat);
                item.values.resize(total);

                // The divisor, decided once for the item rather than per
                // sample: one for all components, one each, or none at all.
                const bool fixed = isFixedPoint(type);
                const bool broadcast = fixed && scope.scal.size() == 1;
                const bool perComp = fixed && scope.scal.size() == size_t(comps);
                item.scaled = broadcast || perComp;

                for (size_t s = 0; s < repeat; ++s) {
                    for (int c = 0; c < comps; ++c) {
                        double v = valueAt(base + body + s * structSize + size_t(c) * size_t(w),
                                           type);
                        const double d = broadcast ? scope.scal[0]
                                       : perComp   ? scope.scal[size_t(c)]
                                                   : 1.0;
                        // A divisor of zero is a divisor this cannot use. Left
                        // alone rather than made infinite, which is a value a
                        // plot would draw.
                        if (d != 0.0) v /= d;
                        item.values[s * size_t(comps) + size_t(c)] = v;
                    }
                }
                mine.push_back({ b.out->size(), repeat });
                b.out->push_back(std::move(item));
            }
        }

        // Padded up to the next four-byte boundary. The advance is at least 8,
        // which is what makes the loop terminate however small the item is —
        // an item declaring size 0 and repeat 0 is legal (a HERO8 writes
        // `FACE` that way when nobody is in shot) and must move the cursor.
        const size_t pad = (4 - (n & 3)) & 3;
        off = body + n + pad;
    }

    // The level is over, so what the level said applies to what the level is
    // about — see `describe`.
    describe(*b.out, mine, scope);
}

} // namespace

DataPayload readGpmfPayload(const uint8_t* data, size_t size) {
    DataPayload out;
    if (!data || size < 8) {
        if (size != 0) out.refusal = "shorter than one GPMF header";
        return out;
    }
    Budget b;
    b.refusal = &out.refusal;
    b.device = &out.device;
    b.out = &out.items;
    walk(data, 0, size, 0, b);
    return out;
}

} // namespace ffmpegbro
