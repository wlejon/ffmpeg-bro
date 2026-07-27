// Laying clips into the output canvas. See export_compositor.h.

#include "export_compositor.h"

#include <algorithm>
#include <cmath>

namespace ffmpegbro {

Compositor::Compositor(int w, int h, int swsFlags) : flags_(swsFlags) {
    canvas_.resize(w, h);
}

void Compositor::clear() {
    // Opaque black, so a canvas nothing covers exports as letterbox rather
    // than as whatever the encoder makes of zero alpha.
    auto* p = reinterpret_cast<uint32_t*>(canvas_.data.data());
    // The picture, not the allocation: Rgba carries slack past the last row
    // for libswscale to spill into, and clearing it would be meaningless work.
    const size_t n = static_cast<size_t>(canvas_.stride) * canvas_.height / 4;
    const uint32_t black = 0xFF000000u;      // little-endian RGBA: A=255
    for (size_t i = 0; i < n; ++i) p[i] = black;
}

void Compositor::draw(const Rgba& src, const ExportClip& c, SwsContext*& sws) {
    if (src.empty() || c.opacity <= 0.001) return;

    const double keepW = 1.0 - c.cropL - c.cropR;
    const double keepH = 1.0 - c.cropT - c.cropB;
    if (keepW <= 0.0 || keepH <= 0.0) return;

    // Where the kept part lands, and which part of the source it is.
    const int dstX = static_cast<int>(std::lround(c.x + c.w * c.cropL));
    const int dstY = static_cast<int>(std::lround(c.y + c.h * c.cropT));
    const int dstW = std::max(1, static_cast<int>(std::lround(c.w * keepW)));
    const int dstH = std::max(1, static_cast<int>(std::lround(c.h * keepH)));

    // Wholly off the canvas: nothing to do, and no scaler to build.
    if (dstX >= canvas_.width || dstY >= canvas_.height ||
        dstX + dstW <= 0 || dstY + dstH <= 0) {
        return;
    }

    const int srcX = clampi(static_cast<int>(std::lround(src.width * c.cropL)),
                            0, src.width - 1);
    const int srcY = clampi(static_cast<int>(std::lround(src.height * c.cropT)),
                            0, src.height - 1);
    const int srcW = clampi(static_cast<int>(std::lround(src.width * keepW)),
                            1, src.width - srcX);
    const int srcH = clampi(static_cast<int>(std::lround(src.height * keepH)),
                            1, src.height - srcY);

    // Cropping is a pointer offset, exactly, because RGBA has no chroma
    // plane to keep aligned — which is the whole reason the source is
    // converted before it is cropped rather than after.
    const uint8_t* srcData[4] = {
        src.data.data() + static_cast<size_t>(srcY) * src.stride + srcX * 4,
        nullptr, nullptr, nullptr};
    const int srcStride[4] = {src.stride, 0, 0, 0};

    sws = sws_getCachedContext(sws, srcW, srcH, AV_PIX_FMT_RGBA,
                               dstW, dstH, AV_PIX_FMT_RGBA,
                               flags_, nullptr, nullptr, nullptr);
    if (!sws) return;

    scratch_.resize(dstW, dstH);
    uint8_t* dstData[4] = {scratch_.data.data(), nullptr, nullptr, nullptr};
    int dstStride[4] = {scratch_.stride, 0, 0, 0};
    if (sws_scale(sws, srcData, srcStride, 0, srcH, dstData, dstStride) <= 0) return;

    blend(scratch_, dstX, dstY, c.opacity);
}

void Compositor::blend(const Rgba& img, int ox, int oy, double opacity) {
    const int x0 = std::max(0, ox), y0 = std::max(0, oy);
    const int x1 = std::min(canvas_.width, ox + img.width);
    const int y1 = std::min(canvas_.height, oy + img.height);
    if (x1 <= x0 || y1 <= y0) return;

    const int op = clampi(static_cast<int>(std::lround(opacity * 255.0)), 0, 255);
    for (int y = y0; y < y1; ++y) {
        const uint8_t* s = img.data.data() +
                           static_cast<size_t>(y - oy) * img.stride + (x0 - ox) * 4;
        uint8_t* d = canvas_.data.data() +
                     static_cast<size_t>(y) * canvas_.stride + x0 * 4;
        for (int x = x0; x < x1; ++x, s += 4, d += 4) {
            const int a = (s[3] * op + 127) / 255;
            if (a == 0) continue;
            if (a == 255) {
                d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
            } else {
                const int ia = 255 - a;
                d[0] = static_cast<uint8_t>((s[0] * a + d[0] * ia + 127) / 255);
                d[1] = static_cast<uint8_t>((s[1] * a + d[1] * ia + 127) / 255);
                d[2] = static_cast<uint8_t>((s[2] * a + d[2] * ia + 127) / 255);
            }
            d[3] = 255;
        }
    }
}

} // namespace ffmpegbro
