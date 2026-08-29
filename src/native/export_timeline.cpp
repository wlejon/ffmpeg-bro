// The edit, as something that answers "what does the output look like at t?"
// See export_timeline.h — in particular why this is where a graph attaches.

#include "export_timeline.h"

#include "export_compositor.h"
#include "export_frame.h"
#include "export_source.h"

#include "util/log.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <thread>

namespace ffmpegbro {

/// Where in its source a clip is at output time `t`.
///
/// One function because two callers need it and they are a frame and a block of
/// sound apart: the picture asks for an instant and the sound asks where to line
/// its reader up. A speed written into one and not the other would put a clip's
/// sound against the wrong pictures of itself, which is the one failure that
/// sounds like a mistake in the edit rather than in the code.
static double srcTimeOf(const ExportClip& c, double t) {
    const double speed = c.speed > 0.0 ? c.speed : 1.0;
    return c.inPoint + (t - c.start) * speed;
}

/// Everything one clip needs open at once, and all of it built lazily — on the
/// first frame this clip is on the canvas, on the first block it is heard in.
///
/// **The sound used to be opened here in the constructor**, because whether
/// there is any sound at all has to be answered before the first frame is
/// written, and the only way to know is to open the file. What that cost is a
/// property of the *edit* rather than of the render: opening a fifteen-gigabyte
/// recording is about 145 ms, and a supercut is many small pieces of a few long
/// files — thirteen cuts of four recordings opened thirteen files and took
/// 1.9 s. That happened wherever `TimelineSource` was built, which for a preview
/// is inside `<video src="/@out/…">`.src on bro's UI thread: pressing play froze
/// the window for the whole of it.
///
/// So the question is answered per *input* instead of per clip — see
/// `TimelineSource`'s constructor — and everything else opens where it is first
/// needed, which for the sound is `mixInto` and therefore never the UI thread.
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
    /// Is this clip heard at all — the settings, the mute and the level, which
    /// are known without opening anything. Not "does the file have a
    /// soundtrack": that is what the open answers.
    bool wantsAudio = false;
    /// The open was tried and did not produce a reader. Kept so a file with no
    /// soundtrack is not re-opened once per block of the mix.
    bool audioFailed = false;

    /// Whether this clip is on screen at `t`. Half-open on purpose: a clip
    /// ending exactly where the next begins must not both be drawn.
    bool covers(double t) const {
        return t >= spec.start - 1e-9 && t < spec.start + spec.length - 1e-9;
    }

    /// Whether this clip puts anything on the canvas at all.
    ///
    /// A clip with no rectangle is one that contributes to the mix and to
    /// nothing else — a music bed, or any clip of a file with no video stream
    /// in it, which `viewer.placement()` says so about by handing back a
    /// rectangle of no size. Without the question the compositor opens it,
    /// fails, and reports a missing picture in the log for a file that was
    /// never asked for one; and it is a question rather than a flag because
    /// the rectangle is already the whole of what the renderer is told about
    /// where a clip goes.
    bool hasPicture() const { return spec.w > 0.5 && spec.h > 0.5; }
};

/// How many inputs may be opened at once when a source is built.
///
/// Eight, and the number is about the disk rather than about the CPU: an open is
/// almost all waiting — a seek, a read, `avformat_find_stream_info` reading a
/// little more — so the threads are not competing for anything except the queue
/// depth of the drive. Enough to make thirteen opens one wait; small enough that
/// a seventy-five-clip montage does not ask a spinning disk for seventy-five
/// scattered reads at once.
static constexpr size_t kOpenAtOnce = 8;

void TimelineSource::openTheFirstOfEach(const ExportSettings& s,
                                        const std::vector<ClipSources*>& firsts,
                                        const std::vector<MediaInput>& theirInputs) {
    if (firsts.empty()) return;

    // One at a time is not worth a thread, and it is the ordinary case for the
    // workbench's timeline — one input under everything.
    if (firsts.size() == 1) {
        ClipSources* cs = firsts[0];
        cs->audio = std::make_unique<SourceAudio>();
        if (cs->audio->open(theirInputs[0], s.audioSampleRate, s.audioChannels,
                            cs->spec.speed)) anyAudio_ = true;
        else { cs->audio.reset(); cs->audioFailed = true; }
        return;
    }

    // Each thread owns its own `ClipSources` and touches nothing else, so there
    // is nothing to lock: the only shared write is `anyAudio_`, and it is a
    // reduction done here once every thread has finished.
    std::atomic<size_t> next{0};
    const size_t workers = std::min(kOpenAtOnce, firsts.size());
    std::vector<std::thread> pool;
    pool.reserve(workers);
    for (size_t w = 0; w < workers; ++w) {
        pool.emplace_back([&] {
            for (;;) {
                const size_t i = next.fetch_add(1);
                if (i >= firsts.size()) return;
                ClipSources* cs = firsts[i];
                auto audio = std::make_unique<SourceAudio>();
                if (audio->open(theirInputs[i], s.audioSampleRate, s.audioChannels,
                                cs->spec.speed)) cs->audio = std::move(audio);
                else cs->audioFailed = true;
            }
        });
    }
    for (auto& t : pool) t.join();

    for (ClipSources* cs : firsts) if (cs->audio) anyAudio_ = true;
}

TimelineSource::TimelineSource(const ExportSettings& s, std::vector<ExportClip> clips)
    : settings_(s) {
    // Bottom of the stack first, so a higher track paints over a lower one —
    // the same order the viewer shows and for the same reason.
    std::stable_sort(clips.begin(), clips.end(),
                     [](const ExportClip& a, const ExportClip& b) { return a.z < b.z; });

    // **Whether there is a soundtrack is a question about the inputs, not about
    // the clips**, and that is the whole of what makes this cheap. `hasAudio()`
    // is asked once, before the first frame — a writer has to know whether to
    // open an audio encoder, and `OutputReader::open` says the same about a
    // pad — so one clip of each distinct input is opened here to answer it. The
    // rest open in `mixInto`, off whatever thread the mix is made on.
    //
    // Thirteen cuts of four recordings: four opens instead of thirteen, and the
    // press that builds this went from 1.9 s to 0.6 s.
    //
    // **And the ones that are left are opened at the same time, because an open
    // is a wait rather than work.** ~110 ms of it is `avformat_find_stream_info`
    // and the decoder, and it is ~110 ms whether the file is fifteen gigabytes or
    // twenty megabytes — so the cost is the *number* of distinct inputs and
    // nothing else, which is exactly the shape that parallelises. A supercut of
    // thirteen cut-out moments is thirteen distinct inputs and cannot be fewer:
    // 1.4 s in a row, 0.2 s at once. Bounded, because a montage of seventy-five
    // clips of seventy-five files would otherwise be seventy-five threads opening
    // seventy-five demuxers against one disk.
    std::vector<std::string> asked;
    std::vector<ClipSources*> firsts;      ///< one clip per distinct input
    std::vector<MediaInput> theirInputs;
    clips_.reserve(clips.size());
    for (const auto& c : clips) {
        auto cs = std::make_unique<ClipSources>(c);
        cs->wantsAudio = s.includeAudio && !c.muted && c.volume > 0.0;
        if (cs->wantsAudio) {
            // By the path the input resolves to, which is what "the same file"
            // means for this question. Two clips of one file with different
            // demuxer options are still one file with or without a soundtrack —
            // and the second of them opens with its own options below, so
            // nothing is being read here on the other's terms.
            MediaInput input = resolveInput(s, c.input, c.path);
            if (std::find(asked.begin(), asked.end(), input.path) == asked.end()) {
                asked.push_back(input.path);
                firsts.push_back(cs.get());
                theirInputs.push_back(std::move(input));
            }
        }
        clips_.push_back(std::move(cs));
    }

    openTheFirstOfEach(s, firsts, theirInputs);

    comp_ = std::make_unique<Compositor>(s.width, s.height, scalerFlag(s.scaler));
}

TimelineSource::~TimelineSource() = default;

const Rgba& TimelineSource::canvasAt(double t) {
    comp_->clear();
    for (auto& cs : clips_) {
        if (!cs->covers(t) || cs->videoFailed || !cs->hasPicture()) continue;
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
        // **The one home for the timeline→source map on this path**, and the clip's
        // speed is its slope: `length` is how much of the *programme* the clip
        // occupies, so a clip at 2× walks twice as far into its file per output
        // second. `ui/project.js`'s `sourceTime` is the same rule in the model and
        // `windowOf` in `ui/graph/derive.js` is the same rule as a `trim`; if one
        // changes, all three do.
        const double srcTime = srcTimeOf(cs->spec, t);
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
        if (!cs->wantsAudio || cs->audioFailed) continue;
        const ExportClip& c = cs->spec;
        const double start = std::max(from, c.start);
        const double stop = std::min(blockEnd, c.start + c.length);
        if (stop <= start) continue;

        // First block this clip is heard in, so this is where its file is
        // opened — the same rule `canvasAt` follows for the picture, and the
        // reason the constructor is cheap. See `ClipSources`.
        if (!cs->audio) {
            cs->audio = std::make_unique<SourceAudio>();
            // `settings_` and not this block's `rate`/`channels`, so that the
            // two places a clip's reader can be opened cannot come to resample
            // it differently. They are the same numbers; saying so once is what
            // keeps them so.
            if (!cs->audio->open(resolveInput(settings_, c.input, c.path),
                                 settings_.audioSampleRate, settings_.audioChannels,
                                 c.speed)) {
                // One clip that will not open is the hole it is, exactly as an
                // unreadable picture is — and the log says which, once.
                LOG_WARN("export: no sound read from %s", c.path.c_str());
                cs->audio.reset();
                cs->audioFailed = true;
                continue;
            }
        }

        const int offset = clampi(
            static_cast<int>(std::llround((start - from) * rate)), 0, frames);
        const int count = clampi(
            static_cast<int>(std::llround((stop - start) * rate)), 0, frames - offset);
        if (count <= 0) continue;

        if (!cs->audioPrimed) {
            // First sound this clip contributes: line its file up with the
            // timeline. After this the reader is pulled strictly forward,
            // which is what keeps it in sync without a seek per block.
            // Through the same map the picture goes through, so the two halves of
            // one clip cannot be lined up differently. `SourceAudio` was opened
            // with the speed and resamples from here forward; this only says where
            // in the file "here" is.
            cs->audio->seekTo(srcTimeOf(c, start));
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
