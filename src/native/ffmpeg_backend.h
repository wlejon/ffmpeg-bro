// The libav media backend — what makes <video src="anything"> work.
//
// This is the GPL half of ffmpeg-bro. It implements bro's codec-agnostic
// bro::video interfaces (MediaSource / VideoDecoder / AudioDecoder) on top of
// libavformat and libavcodec and registers them with bro's media backend
// registry. bro never links or knows about ffmpeg; it just finds a backend
// sitting above its built-in WebM one and uses it.
#pragma once

#include "ffmpeg_input.h"

#include <string>
#include <vector>

namespace ffmpegbro {

// Register the ffmpeg backend with bro::video. Call once, before any media is
// opened. Also quiets libav's default stderr logging into bro's logger.
void registerFfmpegBackend();

// ── What the UI wants to know about the library it is driving ──────────────

struct StreamSummary {
    int index = 0;
    std::string kind;        // "video" | "audio" | "subtitle" | "data"
    std::string codec;       // short name, e.g. "h264"
    std::string codecLong;
    std::string profile;
    int64_t bitRate = 0;
    // This stream's own duration, which is routinely NOT the container's. A
    // recording usually stops the audio a fraction of a second after the last
    // picture, and a clip on a timeline is as long as its pictures — using the
    // container duration leaves the playhead running past the end of the video.
    // 0 when the container doesn't say.
    double duration = 0.0;
    // Video
    int width = 0;
    int height = 0;
    double fps = 0.0;
    std::string pixFmt;
    double sampleAspect = 0.0;   // pixel aspect ratio, 0 when unknown/square
    int rotation = 0;            // degrees, from the display matrix
    // What the file says its colour is, verbatim — empty when it says nothing,
    // which is common and is not the same as saying BT.601. Anything that has
    // to turn "nothing" into a matrix does it by frame height, the way every
    // player does and the way swsSpaceFor() in ffmpeg_export.cpp does; the
    // guess belongs at the point of use, not here, because a probe that
    // invents a tag the file does not carry cannot be trusted about the ones
    // it does.
    std::string colorSpace;
    std::string colorRange;
    std::string colorPrimaries;
    std::string colorTransfer;
    // Audio
    int sampleRate = 0;
    int channels = 0;
    std::string channelLayout;
    std::string sampleFmt;
    // Both
    std::string language;
    std::string title;
    bool isDefault = false;
};

struct ProbeResult {
    bool ok = false;
    std::string error;
    std::string path;
    std::string formatName;
    std::string formatLongName;
    double durationSec = 0.0;
    int64_t bitRate = 0;
    int64_t sizeBytes = 0;
    std::vector<StreamSummary> streams;
};

// Read a file's structure without decoding it — the in-process replacement
// for shelling out to ffprobe.
//
// The input overload is not a convenience: probing wrong is the whole reason
// demuxer options exist, so the answer a source card shows has to be the answer
// *those options* produce. A probe that always used libavformat's defaults
// would disagree with the render the moment anybody set one.
ProbeResult probeMedia(const std::string& path);
ProbeResult probeMedia(const MediaInput& in);

// Version/capability strings for the about panel.
std::string libavVersion();
std::string libavConfiguration();
std::vector<std::string> availableHwAccels();

} // namespace ffmpegbro
