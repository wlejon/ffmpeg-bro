// Making a file that can be *scrubbed*, which is not the same file as one that
// can be watched.
//
// **This exists because of one measurement.** Setting `currentTime` on a media
// element is synchronous — `ElVideo::seekTo` calls `VideoPipeline::settleAt`,
// which decodes until the named instant has arrived, on the UI thread, because
// the documented answer to "what is at t?" is read back on the line after the
// assignment. So a scrub costs whatever a seek costs, per position, and a hand
// dragging a trim edge asks for one per pixel. Measured on a twenty-five second
// 1080p60 H.264 cut with a two-second GOP, forty seeks in a row:
//
//     1080p60, GOP 120 (what a recording and a stream copy of one are)  50 ms
//     1080p60, GOP 15                                                   48 ms
//     1080p60, GOP 4                                                    46 ms
//     1080p60, every frame a keyframe                                   24 ms
//      720p60, GOP 120                                                  40 ms
//      720p60, every frame a keyframe                                   11 ms
//      540p60, every frame a keyframe                                    7 ms
//
// Two things fall out of that table and both of them decide what this file is.
// **Shortening the GOP does almost nothing until it reaches one**: a seek lands
// on a keyframe and walks, and the walk costs about 0.45 ms per picture almost
// regardless of size, so four frames of walking is as good as a hundred and
// twenty and only *none* is different. And **the rest is per pixel** — the
// decode of the one frame that is kept, and the conversion to RGBA the screen
// wants. So the format that makes a scrub instant is: every frame a keyframe,
// at about the size it will be looked at. Nothing else in the table is under a
// 60 Hz frame and this is comfortably under one.
//
// ── Why it is not a render ─────────────────────────────────────────────────
//
// Two reasons, and the second is the one that settled it.
//
// It has no business in `ffmpeg_job.h`'s one slot, for exactly the reason a
// fetch does not (`fetch_queue.h` argues it at length): a proxy is background
// work you start *so that* you can get on, and locking out the Render button
// while a dozen of them are made would be backwards.
//
// And it could not be one anyway. **RGBA is the currency of the export half** —
// `SourceVideo::rgbaAt` converts every decoded picture, the compositor works in
// it, and the encoder converts back — which is right for a render that
// composites a stack of clips and ruinous for a transcode that composites
// nothing. Measured on the same cut, one clip on a 1280x720 canvas through
// `bro.ffmpeg.render.start`: **29.7 s**, against 1.9 s for the same output out
// of ffmpeg's CLI. Nearly all of the difference is two conversions per frame
// that a scale does not need. So the loop here is the one the CLI runs — decode,
// `sws_scale` planes to planes, encode — and it lands in the same order of time.
//
// ── What it is not ─────────────────────────────────────────────────────────
//
// **A proxy is a fact about this machine, not about the edit**, which is
// `ui/localcopy.js`'s rule arriving in a third place. It is never in a document,
// nothing renders from it, and deleting every one of them changes nothing but
// how quickly a scrub answers. That is the whole reason it may be lossy, may be
// small, and may be thrown away.
//
// **One at a time.** A fetch queue is sized by a shared link; this one is sized
// by the encoder, and two transcodes on one card finish later in total than two
// in a row do. There is no `soon` either: they are all a few seconds long and
// the order they were asked for is the order somebody wants them.

#pragma once

#include "ffmpeg_input.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ffmpegbro {

/// What to make, said in the four terms a proxy has. Deliberately **not** an
/// `ExportSettings`: a render spec describes a composite, a canvas, a range, a
/// stream list and a muxer, and a proxy has an opinion about none of them. A
/// struct that said "the whole spec, but ignore most of it" would be an
/// invitation to hand this one and wonder why the crop was dropped.
struct ProxyRequest {
    MediaInput input;      ///< what to read; the window and the demuxer are its own
    std::string path;      ///< where to write, a Matroska file
    int height = 720;      ///< the tall side of the result; the width follows the aspect
    std::string label;     ///< what a UI calls it
};

/// One proxy, as everything watching sees it.
struct ProxyStatus {
    uint64_t id = 0;
    std::string label;
    std::string path;
    enum class State { Queued, Running, Done, Failed, Cancelled };
    State state = State::Queued;
    double progress = 0.0;   ///< 0…1, or 0 while nobody knows how long the input is
    double position = 0.0;   ///< seconds of the input transcoded
    double span = 0.0;       ///< seconds there are, or 0 when the input does not say
    double elapsedSec = 0.0;
    int64_t frames = 0;
    int64_t bytes = 0;
    std::string error;
};

/// Queue one. Returns the number it will be known by, or 0 with a reason.
///
/// Refused here rather than on the thread when there is no input, no path, or a
/// height that is not a size — a proxy that failed for one of those a few
/// seconds later would be a wait somebody watched not end.
uint64_t startProxy(const ProxyRequest& r, std::string* err);

/// Every proxy this process knows about, in arrival order. Terminal entries
/// stay until `clearFinishedProxies()`.
std::vector<ProxyStatus> proxyList();

/// One of them by number; a zero `id` back means there is no such proxy.
ProxyStatus proxyStatus(uint64_t id);

/// Ask one to stop. Queued: dropped. Running: answers within a frame or two.
///
/// **What is on disk is left there**, which is the one place this differs from a
/// fetch in *meaning* rather than in wording: a half-written proxy is a file
/// with a Matroska header and no trailer, and `startProxy` on the same path
/// simply overwrites it. Nothing reads a proxy that was not reported `Done`.
void stopProxy(uint64_t id);

/// Every one of them, and wait for the thread. For shutdown and for tests.
void stopAllProxies();

/// Forget the terminal entries. The running and queued ones stay.
void clearFinishedProxies();

/// Block until nothing is queued or running. Tests; the UI polls.
void waitForProxies();

} // namespace ffmpegbro
