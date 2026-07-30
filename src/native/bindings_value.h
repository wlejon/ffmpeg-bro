// The vocabulary `bro.ffmpeg` is written in: reading one property off a plain
// JS object, and building the handful of shapes every answer is made of.
//
// Every argument this surface takes is a JS object literal the UI wrote, so
// every field is optional and every default belongs here rather than repeated
// at each of the callers. That is the whole of it — the *spec* readers built on
// top of these live in bindings_spec.h.
//
// **These are deliberately not qjsbind's `get_prop_*`.** Two differences, both
// load-bearing:
//
//   - a number that is not a number is the fallback. `JS_ToFloat64` reports
//     success and writes NaN for a string nobody meant as a number, and a NaN
//     that reached `ExportSettings` would be a render whose comparisons are all
//     false rather than an error anybody sees.
//   - a string is read with its length, so a value carrying a NUL survives as
//     what it is instead of being cut at it.
//
// Absent, `null` and `undefined` all mean the fallback, which is what lets the
// UI keep a blank control in its model without it reaching libav.
#pragma once

#include "sound_meter.h"

#include <quickjs.h>

#include <string>
#include <vector>

namespace ffmpegbro {

/// Set a string property from a `std::string`, length and all.
void setStr(JSContext* ctx, JSValue obj, const char* key, const std::string& v);

/// A finite number, or `fallback`.
double numProp(JSContext* ctx, JSValueConst obj, const char* key, double fallback);

/// A boolean by JS's own truthiness, or `fallback` when there is nothing there.
bool boolProp(JSContext* ctx, JSValueConst obj, const char* key, bool fallback);

/// A string, or `fallback`. Only an actual string counts: a number here is a
/// caller that meant something else.
std::string strProp(JSContext* ctx, JSValueConst obj, const char* key,
                    const std::string& fallback);

/// How long a JS array says it is. Three copies of these four lines were
/// enough; there are eleven now.
uint32_t arrayLength(JSContext* ctx, JSValueConst arr);

/// A name argument, or false. Every `(name)` call takes one, and what makes
/// this a check rather than a conversion is that `undefined` must not become
/// the string "undefined" and then an empty answer about a thing of that name:
/// a call with nothing in it is a mistake worth an exception. An empty *string*
/// is a caller with an empty field, which is its own answer.
bool takeName(JSContext* ctx, JSValueConst v, std::string* out);

JSValue stringsToJs(JSContext* ctx, const std::vector<std::string>& v);
JSValue intsToJs(JSContext* ctx, const std::vector<int>& v);

/// A meter's reading, one object per channel of whatever was measured.
///
/// Here rather than in either of the two files that hand one back, because a
/// capture session's pads and the output preview's mix are read by the same meter
/// in the UI (`ui/meter.js`) and a shape that differed between them by a key name
/// would be two meters. `name` is libav's own — see `ChannelLevel`.
JSValue channelsToJs(JSContext* ctx, const std::vector<ChannelLevel>& v);

} // namespace ffmpegbro
