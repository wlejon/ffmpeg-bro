// What `bro.ffmpeg` is made of, one file per part of ffmpeg's own model.
//
// Each of these owns a region of the surface outright: the functions, the
// helpers that build their answers, and the prose saying why the calls are
// shaped as they are. `installFfmpegBindings` is then a list of them, which is
// the point — the note explaining that a recording shares `render.poll()`
// belongs next to `record`, not in a registration function three hundred lines
// from it.
//
// They take the table rather than returning one because several add more than a
// table: `capabilities` puts a dozen properties straight onto `bro.ffmpeg`, and
// `playback` adds three tables of its own.
#pragma once

#include "bindings_table.h"

namespace ffmpegbro {

/// `probe` — what libavformat makes of a file. bindings_probe.cpp.
void installProbe(Table& ns);

/// `render.start` / `poll` / `cancel` — the job that writes a file, and the
/// spec it is given. bindings_render.cpp.
void installRender(Table& ns);

/// `record.*` and `live.*` — reading devices, with and without a writer on the
/// end. bindings_capture.cpp.
void installCapture(Table& ns);

/// Everything this build *can* do, asked of libav rather than listed: codecs,
/// muxers, demuxers, protocols, devices, filters, their option tables, and the
/// queries about one input that go with them. bindings_capabilities.cpp.
void installCapabilities(Table& ns);

/// `inputs`, `views` and `output` — the three registries that let a
/// `<video src>` name something this binary made. bindings_playback.cpp.
void installPlayback(Table& ns);

/// What a drop of files amounts to, and the temporary path a render writes
/// through. bindings_sequence.cpp.
void installSequences(Table& ns);

/// `expr.evaluate` — libavutil's expression evaluator, so a filter option
/// written as an expression can be drawn as the curve libavfilter will perform.
/// bindings_expr.cpp.
void installExpression(Table& ns);

} // namespace ffmpegbro
