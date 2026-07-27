// An RGBA picture, and the handful of libav helpers everything on the encode
// side needs.
//
// RGBA is the currency of this half of the application. Sources decode into
// it, the compositor works in it, and the writer converts out of it exactly
// once, on the way to the encoder — which is what lets a crop be a pointer
// offset with no chroma plane to keep aligned, and what lets an alpha blend be
// a loop over four bytes instead of a filter graph.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/pixfmt.h>
#include <libswscale/swscale.h>
}

namespace ffmpegbro {

/// libav's error string for a return code, as a std::string.
std::string avErr(int code);

int clampi(int v, int lo, int hi);

/// Rotation from a stream's display matrix, in degrees clockwise. The decoder
/// hands back the picture as it was coded; only this side-datum says a phone
/// held upright wrote a landscape frame.
int rotationOf(const AVStream* st);

/// Tell swscale which matrix the two sides are in. Without this every
/// conversion runs on libswscale's default — BT.601 — and an HD source decoded
/// with SD coefficients comes out visibly green-shifted in the shadows. Best
/// effort: a scaler that will not take the details still works, it just works
/// the way it always did.
void setColorspace(SwsContext* sws, int srcSpace, int srcFullRange,
                   int dstSpace, int dstFullRange);

/// The swscale colour-matrix id for a frame, from its tag and, failing that,
/// its size — which is the same guess every player makes.
///
/// **ui/filtergraph.js implements this rule again**, in the scale filter's
/// vocabulary, so that the command it prints describes the colour this render
/// actually has. If the fallback changes here it changes there.
int swsSpaceFor(AVColorSpace space, int height);

/// A scaler name from the settings as an SWS_* flag. Unknown names get
/// bicubic rather than an error: the setting is a preference, and a render
/// that refuses to run because of a typo in a preference is worse than one
/// that runs at the default.
int scalerFlag(const std::string& name);

// ── An RGBA picture, however it was stored on the way in ───────────────────

struct Rgba {
    std::vector<uint8_t> data;
    int width = 0;
    int height = 0;
    int stride = 0;

    void resize(int w, int h) {
        width = w;
        height = h;
        stride = w * 4;
        data.resize(static_cast<size_t>(stride) * h);
    }
    bool empty() const { return width <= 0 || height <= 0; }
};

/// Turn the picture a quarter, a half or three quarters. Done on RGBA rather
/// than on the decoded planes because at four bytes a pixel it is one loop
/// with no chroma siting to get wrong.
void rotateRgba(const Rgba& src, int degrees, Rgba& dst);

} // namespace ffmpegbro
