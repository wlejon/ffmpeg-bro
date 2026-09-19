// The vocabulary `bro.ffmpeg` is written in: reading one property off a plain
// JS object, and building the handful of shapes every answer is made of.
//
// Every argument this surface takes is a JS object literal the UI wrote, so
// every field is optional and every default belongs here rather than repeated
// at each of the callers. That is the whole of it — the *spec* readers built on
// top of these live in bindings_spec.h.
//
// Absent, `null` and `undefined` all mean the fallback, which is what lets the
// UI keep a blank control in its model without it reaching libav.
#pragma once

#include "sound_meter.h"

#include <embed/embed.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// Set a string property from a `std::string`, length and all.
void setStr(bronze::Value obj, const char* key, const std::string& v);

/// Set a numeric property.
void setNum(bronze::Value obj, const char* key, double val);

/// Set a boolean property.
void setBool(bronze::Value obj, const char* key, bool val);

/// A finite number, or `fallback`.
double numProp(bronze::Value obj, const char* key, double fallback = 0.0);

/// A boolean by JS's own truthiness, or `fallback` when there is nothing there.
bool boolProp(bronze::Value obj, const char* key, bool fallback = false);

/// A string, or `fallback`. Only an actual string counts: a number here is a
/// caller that meant something else.
std::string strProp(bronze::Value obj, const char* key,
                    const std::string& fallback = "");

/// Whether the value is an Array.
bool isArray(bronze::Value arr);

/// How long a JS array says it is.
uint32_t arrayLength(bronze::Value arr);

/// Allocate a new empty JS array.
bronze::Value createArray();

/// A name argument, or false. Every `(name)` call takes one, and what makes
/// this a check rather than a conversion is that `undefined` must not become
/// the string "undefined" and then an empty answer about a thing of that name:
/// a call with nothing in it is a mistake worth an exception. An empty *string*
/// is a caller with an empty field, which is its own answer.
bool takeName(bronze::Value v, std::string* out);

bronze::Value stringsToJs(const std::vector<std::string>& v);
bronze::Value intsToJs(const std::vector<int>& v);

/// A meter's reading, one object per channel of whatever was measured.
///
/// Here rather than in either of the two files that hand one back, because a
/// capture session's pads and the output preview's mix are read by the same meter
/// in the UI (`ui/meter.js`) and a shape that differed between them by a key name
/// would be two meters. `name` is libav's own — see `ChannelLevel`.
bronze::Value channelsToJs(const std::vector<ChannelLevel>& v);

/// Audio channels / float array as Float32Array.
bronze::Value channelsToJs(const std::vector<float>& v);

} // namespace ffmpegbro
