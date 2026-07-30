// GPMF — GoPro's metadata format, the payload of a `gpmd` track.
//
// The first parser behind ffmpeg_data.h's seam, and the only one today. The
// seam does not name GoPro; this file does, because this is where the knowledge
// of one format lives.
//
// **This reads sizes and counts out of an untrusted file, and it is written
// that way.** Every length, every repeat count and every level of nesting in a
// GPMF stream comes from the file itself. A `.mp4` that was truncated by a
// camera losing power, or written to be hostile, is the case to design for and
// not an edge of it — so nothing declared is believed: every read is checked
// against the bytes actually present, the nesting is capped, the item count and
// the value count are capped, and the walk is proved to make progress so a
// zero-length item cannot loop it. A parser that segfaults on a bad file is a
// worse outcome than a camera's speed never being plotted, which is what the
// alternative was. `tests/data_test.cpp` truncates a real payload at every
// four-byte boundary, scribbles oversized lengths into every header, and nests
// a payload inside itself; the requirement is that each of those *refuses*, and
// the refusal names what it found.
//
// ── the format ───────────────────────────────────────────────────────────
//
// Nested KLV, big-endian, aligned to four bytes. One item is:
//
//     FourCC key | type char | uint8 struct size | uint16 repeat | payload
//
// and the payload is `size × repeat` bytes, padded up to the next multiple of
// four. `size` is the size of one **sample of all its components** — an
// accelerometer sample is three int16s, so `size` is 6 and `repeat` is the
// number of samples. A type of `0` means the payload is itself GPMF, which is
// how `DEVC` contains `STRM` contains the sample keys.
//
// Verified against real files rather than from the specification alone: a
// HERO8 Black's `gpmd` track, both a 21-second and an 11.8-minute recording.
// Every claim below that says "measured" was measured there.
//
// ── SCAL, which is the part worth getting right ──────────────────────────
//
// `SCAL` is a **divisor**, and a value reported without it is off by orders of
// magnitude while still looking entirely plausible — a raw `GPS5` latitude of
// 474305352 is a number, and 47.4305352° is a place. Three things about it were
// checked against the files rather than assumed:
//
//   - It can carry **one divisor for all components or one per component**.
//     `ACCL`'s is a single int16 of 417 covering all three axes; `GPS5`'s is
//     five int32s (10000000, 10000000, 1000, 1000, 100) for its five. A count
//     that is neither one nor the component count is not resolved by picking
//     the first: the item is left unscaled and says so, because a wrong divisor
//     is indistinguishable from a right one once the number is drawn.
//
//   - It applies **only to integer-typed items**. This is the rule that is easy
//     to get wrong, and the files settle it: in an accelerometer stream the
//     order is `SIUN`, `SCAL`, `TMPC`, `ACCL`, and `TMPC` is a float32 already
//     in degrees C — 64.57 °C, which divided by 417 would be 0.155 °C and would
//     look like a plausible reading of something. A divisor exists to undo a
//     fixed-point encoding, so an item that was not encoded that way has
//     nothing to undo. Counted over an 11.8-minute HERO8 recording: every item
//     with a divisor in scope is either an integer that needs it (`ACCL`,
//     `GYRO`, `GPS5`, `CORI`, `IORI`, `GRAV`) or a float or fourcc that must not
//     have it (`TMPC`, `GPSA`), with no exceptions.
//
//   - Its scope is the `STRM` it is in, from where it appears onwards. A nested
//     item starts with none inherited, which is what stops one stream's divisor
//     reaching the next.
//
// ── what becomes a series, and what does not ─────────────────────────────
//
// **Nothing here lists the sample keys**, and that is the point. `GPS5`, `ACCL`,
// `SHUT` and the rest are never named: a numeric item that is not one of the
// structural keys below is data, whatever it is called, so a camera firmware
// that starts writing a key nobody has seen plots it with no edit here. What
// the file supplies instead of a lookup table is better than one — `STNM` is
// the quantity's name in words ("Exposure time (shutter speed)"), `SIUN` and
// `UNIT` are its units, and both come out of the payload.
//
// `KNOWN_STRUCTURE` is the one list, and it admits it cannot be complete: GPMF's
// structural vocabulary is prose in GoPro's specification, published nowhere as
// data, so this is the set observed in real files and named there as
// description. **The cost of an omission is bounded and one-directional**: a
// structural key this list does not know becomes a series with an odd name on
// the picker and nothing else — a row too many, never a wrong number. The cost
// of a wrong *inclusion* is the opposite, a real quantity silently absent, so
// nothing goes in without having been seen doing description work in a file.
#pragma once

#include "ffmpeg_data.h"

#include <cstddef>
#include <cstdint>

namespace ffmpegbro {

/// How deep the walk will go. Real payloads are two levels — `DEVC` > `STRM` >
/// items — and this leaves headroom for a format revision without leaving any
/// for a file that nests a thousand times to blow the C stack. Reaching it
/// stops that branch with a refusal naming the depth.
inline constexpr int kGpmfMaxDepth = 6;

/// The most items one packet may contain. A HERO8 packet holds about 200. A
/// packet is at most 16 MB by construction (255 × 65535 payload bytes), which
/// at the 8-byte minimum item is two million empty headers — so this is the cap
/// that stops a well-formed-but-absurd packet from being a two-million-entry
/// table.
inline constexpr int kGpmfMaxItems = 8192;

/// The most numbers one packet may yield. A HERO8 packet yields about 4500.
/// This bounds the allocation a single packet can provoke to 8 MB of doubles,
/// independently of every other cap.
inline constexpr int kGpmfMaxValues = 1 << 20;

/// Parse one `gpmd` packet.
///
/// Never throws, never reads outside `[data, data + size)`, and always
/// terminates: every item advances the cursor by at least the 8-byte header, so
/// a zero-length item makes progress rather than looping.
///
/// A packet that ends mid-item, declares more bytes than are present, nests
/// past `kGpmfMaxDepth` or exceeds either cap comes back with whatever parsed
/// before that point and a `refusal` naming what was found and at which byte.
/// The alternative — discarding the whole packet — was rejected because the
/// items in front of the damage were fully bounds-checked and are exactly as
/// good as any others; keeping them is not an approximation of anything.
DataPayload readGpmfPayload(const uint8_t* data, size_t size);

} // namespace ffmpegbro
