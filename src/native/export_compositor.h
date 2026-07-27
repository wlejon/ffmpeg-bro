// Laying clips into the output canvas.
//
// The same arithmetic ui/viewer.js does with a div and overflow:hidden: the
// window is the kept part of the placed rectangle, and the picture inside it
// stays whole. Doing it here on pixels rather than on style properties is the
// only difference between what you are looking at and what gets written —
// which is why the caller hands over rectangles already computed in canvas
// pixels rather than the fit/zoom/pan/grid inputs they came from.
//
// This is one way of producing an output frame, and for now it is the only
// one. A node graph is the other: an `overlay` node is this class with its
// inputs named explicitly instead of taken from a track stack. Whatever
// arrives, it arrives here — nothing above this file knows how a canvas is
// filled in, only that it is.
#pragma once

#include "export_frame.h"
#include "ffmpeg_export.h"

namespace ffmpegbro {

class Compositor {
public:
    Compositor(int w, int h, int swsFlags = SWS_BICUBIC);

    /// Opaque black, so a canvas nothing covers exports as letterbox rather
    /// than as whatever the encoder makes of zero alpha.
    void clear();

    /// Place one clip's picture. `src` is in display orientation. `sws` is the
    /// caller's cached scaler for this clip — one per clip, because the sizes
    /// it is built for are the clip's own and rebuilding it per frame would
    /// throw away the filter tables every time.
    void draw(const Rgba& src, const ExportClip& c, SwsContext*& sws);

    const Rgba& canvas() const { return canvas_; }

private:
    /// Alpha-composite `img` at (ox, oy), clipped to the canvas. The source's
    /// own alpha and the clip's opacity multiply, so a ProRes 4444 with a real
    /// alpha channel at 50% behaves the way both say it should.
    void blend(const Rgba& img, int ox, int oy, double opacity);

    Rgba canvas_, scratch_;
    int flags_ = SWS_BICUBIC;
};

} // namespace ffmpegbro
