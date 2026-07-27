// The edit, as something that answers "what does the output look like at t?"
// See export_timeline.h — in particular why this is where a graph attaches.

#include "export_timeline.h"

#include "export_compositor.h"
#include "export_frame.h"
#include "export_source.h"

#include "util/log.h"

#include <algorithm>
#include <cmath>

namespace ffmpegbro {

/// Everything one clip needs open at once. Built lazily for the picture and
/// eagerly for the sound, because whether there is any sound at all has to be
/// answered before the first frame is written.
class ClipSources {
public:
    explicit ClipSources(const ExportClip& c) : spec(c) {}
    ~ClipSources() { if (scaler) sws_freeContext(scaler); }

    ExportClip spec;
    std::unique_ptr<SourceVideo> video;
    std::unique_ptr<SourceAudio> audio;
    SwsContext* scaler = nullptr;
    bool videoFailed = false;
    bool audioPrimed = false;

    /// Whether this clip is on screen at `t`. Half-open on purpose: a clip
    /// ending exactly where the next begins must not both be drawn.
    bool covers(double t) const {
        return t >= spec.start - 1e-9 && t < spec.start + spec.length - 1e-9;
    }
};

TimelineSource::TimelineSource(const ExportSettings& s, std::vector<ExportClip> clips)
    : settings_(s) {
    // Bottom of the stack first, so a higher track paints over a lower one —
    // the same order the viewer shows and for the same reason.
    std::stable_sort(clips.begin(), clips.end(),
                     [](const ExportClip& a, const ExportClip& b) { return a.z < b.z; });

    clips_.reserve(clips.size());
    for (const auto& c : clips) {
        auto cs = std::make_unique<ClipSources>(c);
        if (s.includeAudio && !c.muted && c.volume > 0.0) {
            cs->audio = std::make_unique<SourceAudio>();
            if (cs->audio->open(resolveInput(s, c.input, c.path),
                                s.audioSampleRate, s.audioChannels)) anyAudio_ = true;
            else cs->audio.reset();
        }
        clips_.push_back(std::move(cs));
    }

    comp_ = std::make_unique<Compositor>(s.width, s.height, scalerFlag(s.scaler));
}

TimelineSource::~TimelineSource() = default;

const Rgba& TimelineSource::canvasAt(double t) {
    comp_->clear();
    for (auto& cs : clips_) {
        if (!cs->covers(t) || cs->videoFailed) continue;
        if (!cs->video) {
            cs->video = std::make_unique<SourceVideo>();
            std::string open;
            if (!cs->video->open(resolveInput(settings_, cs->spec.input, cs->spec.path),
                                 &open)) {
                // One unreadable clip should not throw away the render; it
                // exports as the hole it is, and the log says why.
                LOG_WARN("export: %s", open.c_str());
                cs->video.reset();
                cs->videoFailed = true;
                continue;
            }
        }
        const double srcTime = cs->spec.inPoint + (t - cs->spec.start);
        if (const Rgba* pic = cs->video->rgbaAt(srcTime))
            comp_->draw(*pic, cs->spec, cs->scaler);
    }
    return comp_->canvas();
}

bool TimelineSource::exhausted(double t) const {
    for (const auto& cs : clips_)
        if (cs->spec.start + cs->spec.length > t + 1e-9) return false;
    return true;
}

void TimelineSource::mixInto(float* dst, double from, int frames, int rate, int channels) {
    const double blockEnd = from + double(frames) / rate;

    for (auto& cs : clips_) {
        if (!cs->audio) continue;
        const ExportClip& c = cs->spec;
        const double start = std::max(from, c.start);
        const double stop = std::min(blockEnd, c.start + c.length);
        if (stop <= start) continue;

        const int offset = clampi(
            static_cast<int>(std::llround((start - from) * rate)), 0, frames);
        const int count = clampi(
            static_cast<int>(std::llround((stop - start) * rate)), 0, frames - offset);
        if (count <= 0) continue;

        if (!cs->audioPrimed) {
            // First sound this clip contributes: line its file up with the
            // timeline. After this the reader is pulled strictly forward,
            // which is what keeps it in sync without a seek per block.
            cs->audio->seekTo(c.inPoint + (start - c.start));
            cs->audioPrimed = true;
        }
        cs->audio->mixInto(dst + size_t(offset) * channels, count,
                           static_cast<float>(c.volume));
    }

    // Several clips summed can leave the range; clamping is what a mixer does,
    // and it beats the wrap a conversion would do.
    const size_t total = static_cast<size_t>(frames) * channels;
    for (size_t i = 0; i < total; ++i)
        dst[i] = dst[i] < -1.0f ? -1.0f : (dst[i] > 1.0f ? 1.0f : dst[i]);
}

} // namespace ffmpegbro
