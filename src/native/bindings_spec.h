// Reading the render spec — `ui/export/spec.js` `buildSpec()`'s object, turned
// into `ExportSettings` and the vectors that hang off it.
//
// It is its own file because it has more than one caller and they must not come
// to disagree: `render.start` renders it, `record.start` writes a capture with
// it, `output.define` previews it, and `probe`, `inputs.define`, `views.define`,
// `keyframes` and `cueTimes` all read *an input* out of the same vocabulary. A
// second copy of any of this would be a second set of defaults for the Sources
// stage to quietly disagree with the render about.
//
// **A malformed spec is an error naming the field, never a render that
// succeeded while leaving something out.** That is the difference between the
// readers here that return a value and the ones that return `bool` with a
// `std::string* err`: the first kind describes something whose absence is a
// legitimate answer, the second something whose *wrongness* has to reach the
// caller with a reason in it.
#pragma once

#include <quickjs.h>

#include <string>
#include <vector>

#include "ffmpeg_export.h"
#include "ffmpeg_input.h"

namespace ffmpegbro {

/// `{ g: 60, bf: 2, "x264-params": "aq-mode=3" }` — the natural JS shape for a
/// bag of ffmpeg arguments, read off `owner[key]`.
std::vector<ExportOption> optionsFromJs(JSContext* ctx, JSValueConst owner, const char* key);

/// `{ path, format, options, ss, t, to, itsoffset }` — one `-i`, as JS writes
/// one.
MediaInput inputFromJs(JSContext* ctx, JSValueConst o);

/// One clip out of `spec.clips`, its rectangle already in canvas pixels.
ExportClip clipFromJs(JSContext* ctx, JSValueConst o);

/// A `clips` array off whatever object carries one — the spec, or one of its
/// passes.
std::vector<ExportClip> clipsFromJs(JSContext* ctx, JSValueConst o);

/// `item.bsf` — `[{ name, options }, …]`, in the order they run. `where` names
/// the thing being read for the error message.
bool bsfFromJs(JSContext* ctx, JSValueConst item, const std::string& where,
               std::vector<ExportBsf>* out, std::string* err);

/// `spec.streams` — what the muxer maps, and with what.
bool streamsFromJs(JSContext* ctx, JSValueConst spec, std::vector<ExportStream>* out,
                   std::string* err);

/// `spec.chapters` — beside the streams rather than among them.
bool chaptersFromJs(JSContext* ctx, JSValueConst spec, std::vector<ExportChapter>* out,
                    std::string* err);

/// `spec.filterInputs` — the graph's own input nodes.
std::vector<ExportGraphInput> graphInputsFromJs(JSContext* ctx, JSValueConst spec);

/// `spec.passes` — the reasons one render is several walks over the frames.
std::vector<ExportPass> passesFromJs(JSContext* ctx, JSValueConst spec);

/// `spec.inputs` — the `-i`s, in the order the clips index them by.
bool inputsFromJs(JSContext* ctx, JSValueConst spec, std::vector<MediaInput>* out,
                  std::string* err);

/// The whole of it: one reader for the render, the recording and the preview.
bool outputFromJs(JSContext* ctx, JSValueConst spec, ExportSettings* out, std::string* err);

} // namespace ffmpegbro
