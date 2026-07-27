// An RGBA picture, and the handful of libav helpers everything on the encode
// side needs. See export_frame.h for what they are for.

#include "export_frame.h"

extern "C" {
#include <libavutil/display.h>
}

#include <algorithm>
#include <cmath>

namespace ffmpegbro {

std::string avErr(int code) {
    char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(code, buf, sizeof(buf));
    return buf;
}

int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/// Rotation from a stream's display matrix, in degrees clockwise. The decoder
/// hands back the picture as it was coded; only this side-datum says a phone
/// held upright wrote a landscape frame.
int rotationOf(const AVStream* st) {
    const AVPacketSideData* sd =
        av_packet_side_data_get(st->codecpar->coded_side_data,
                                st->codecpar->nb_coded_side_data,
                                AV_PKT_DATA_DISPLAYMATRIX);
    if (!sd) return 0;
    double deg = av_display_rotation_get(reinterpret_cast<const int32_t*>(sd->data));
    if (deg != deg) return 0;   // NaN
    int d = static_cast<int>(std::lround(-deg)) % 360;
    if (d < 0) d += 360;
    // Only the right angles can be done by moving pixels around; anything else
    // would need a real resampling pass and does not occur in the wild.
    return (d == 90 || d == 180 || d == 270) ? d : 0;
}

/// Tell swscale which matrix the two sides are in. Without this every
/// conversion runs on libswscale's default — BT.601 — and an HD source
/// decoded with SD coefficients comes out visibly green-shifted in the
/// shadows. Best effort: a scaler that will not take the details still works,
/// it just works the way it always did.
void setColorspace(SwsContext* sws, int srcSpace, int srcFullRange,
                   int dstSpace, int dstFullRange) {
    if (!sws) return;
    int *invTable = nullptr, *table = nullptr;
    int srcRange = 0, dstRange = 0, brightness = 0, contrast = 0, saturation = 0;
    if (sws_getColorspaceDetails(sws, &invTable, &srcRange, &table, &dstRange,
                                 &brightness, &contrast, &saturation) < 0) {
        return;
    }
    sws_setColorspaceDetails(sws, sws_getCoefficients(srcSpace), srcFullRange,
                             sws_getCoefficients(dstSpace), dstFullRange,
                             brightness, contrast, saturation);
}

/// The swscale colour-matrix id for a frame, from its tag and, failing that,
/// its size — which is the same guess every player makes.
int swsSpaceFor(AVColorSpace space, int height) {
    switch (space) {
        case AVCOL_SPC_BT709:       return SWS_CS_ITU709;
        case AVCOL_SPC_BT470BG:     return SWS_CS_ITU601;
        case AVCOL_SPC_SMPTE170M:   return SWS_CS_SMPTE170M;
        case AVCOL_SPC_SMPTE240M:   return SWS_CS_SMPTE240M;
        case AVCOL_SPC_FCC:         return SWS_CS_FCC;
        case AVCOL_SPC_BT2020_NCL:
        case AVCOL_SPC_BT2020_CL:   return SWS_CS_BT2020;
        default: break;
    }
    return height >= 720 ? SWS_CS_ITU709 : SWS_CS_ITU601;
}

int scalerFlag(const std::string& name) {
    if (name == "fast_bilinear") return SWS_FAST_BILINEAR;
    if (name == "bilinear")      return SWS_BILINEAR;
    if (name == "neighbor" || name == "point") return SWS_POINT;
    if (name == "area")          return SWS_AREA;
    if (name == "gauss")         return SWS_GAUSS;
    if (name == "sinc")          return SWS_SINC;
    if (name == "lanczos")       return SWS_LANCZOS;
    if (name == "spline")        return SWS_SPLINE;
    return SWS_BICUBIC;
}

/// Turn the picture a quarter, a half or three quarters. Done on RGBA rather
/// than on the decoded planes because at four bytes a pixel it is one loop
/// with no chroma siting to get wrong.
void rotateRgba(const Rgba& src, int degrees, Rgba& dst) {
    if (degrees == 0) return;
    const bool swap = (degrees == 90 || degrees == 270);
    dst.resize(swap ? src.height : src.width, swap ? src.width : src.height);
    const auto* s = reinterpret_cast<const uint32_t*>(src.data.data());
    auto* d = reinterpret_cast<uint32_t*>(dst.data.data());
    const int sw = src.width, sh = src.height;
    const int sStride = src.stride / 4, dStride = dst.stride / 4;

    for (int y = 0; y < sh; ++y) {
        const uint32_t* row = s + static_cast<size_t>(y) * sStride;
        for (int x = 0; x < sw; ++x) {
            int dx, dy;
            if (degrees == 90)       { dx = sh - 1 - y; dy = x; }
            else if (degrees == 180) { dx = sw - 1 - x; dy = sh - 1 - y; }
            else                     { dx = y;          dy = sw - 1 - x; }
            d[static_cast<size_t>(dy) * dStride + dx] = row[x];
        }
    }
}

} // namespace ffmpegbro
