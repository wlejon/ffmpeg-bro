// The render, on playback. See playback_output.h — in particular why the caller
// owns the seek and why there is no sound here.

#include "playback_output.h"

#include "export_frame.h"
#include "export_graph.h"
#include "export_timeline.h"

#include "util/log.h"

extern "C" {
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
}

#include <algorithm>
#include <cmath>
#include <map>
#include <mutex>

namespace ffmpegbro {
namespace {

/// A token, not a path. Starts with a slash for the reason `defineInput`'s and
/// `viewToken`'s do — bro resolves anything that does not against the document —
/// and says what it is, because it turns up in logs beside real filenames.
const char* kPrefix = "/@out/";

std::mutex& lock() {
    static std::mutex m;
    return m;
}

std::map<std::string, OutputView>& table() {
    static std::map<std::string, OutputView> t;
    return t;
}

/// The range, as the part of the token that makes a moved playhead a new src.
///
/// Milliseconds and not seconds: a token is a string that has to compare equal
/// to itself, and printing a double at full precision to get that would put
/// `1.2999999999999998` in a log. A millisecond is two orders of magnitude
/// finer than the frame this addresses.
std::string rangePart(const ExportSettings& s) {
    const long long from = std::llround(s.startTime * 1000.0);
    const long long to = std::llround(s.endTime * 1000.0);
    return std::to_string(from) + "-" + std::to_string(to);
}

/// The source this spec renders through — the same choice `runExport` makes, and
/// the whole of what makes a preview the render rather than a resemblance of it.
///
/// **`includeAudio` is turned off first**, and it has to happen before the
/// source is constructed rather than after: `TimelineSource`'s constructor opens
/// a `SourceAudio` per clip to answer `hasAudio()`, so a preview that left it on
/// would open every file on the timeline for samples nobody reads. See the
/// header.
std::unique_ptr<FrameSource> sourceFor(ExportSettings s, std::vector<ExportClip> clips,
                                       int* width, int* height, bool* isGraph,
                                       std::string* err) {
    s.includeAudio = false;
    if (!s.filterGraph.empty()) {
        auto g = std::make_unique<GraphSource>(s);
        if (!g->build(err)) return nullptr;
        // What the graph turned out to be. `sizeFromGraph` is a render with no
        // opinion of its own — a node half-way down a graph is whatever size
        // libavfilter made it — and the picture on the screen has to be that
        // size for the same reason the writer would have to be opened for it.
        *width = s.sizeFromGraph ? g->outWidth() : s.width;
        *height = s.sizeFromGraph ? g->outHeight() : s.height;
        *isGraph = true;
        return g;
    }
    *width = s.width;
    *height = s.height;
    *isGraph = false;
    return std::make_unique<TimelineSource>(s, std::move(clips));
}

/// One RGBA canvas, as a frame of its own to hand over.
///
/// Copied rather than referenced, because the compositor owns one buffer and
/// paints the next frame into it — see `OutputReader::next`. `av_frame_get_buffer`
/// rather than a plain allocation so the picture is refcounted the way every
/// other frame in this binary is, which is what lets the packet path hold it.
AVFrame* frameOf(const Rgba& canvas, double at, double fps) {
    if (canvas.empty()) return nullptr;
    AVFrame* f = av_frame_alloc();
    if (!f) return nullptr;
    f->format = AV_PIX_FMT_RGBA;
    f->width = canvas.width;
    f->height = canvas.height;
    if (av_frame_get_buffer(f, 0) < 0) { av_frame_free(&f); return nullptr; }

    const uint8_t* src = canvas.data.data();
    av_image_copy_plane(f->data[0], f->linesize[0], src, canvas.stride,
                        canvas.width * 4, canvas.height);

    // Microseconds, which is what the track is described in — one clock for the
    // whole of this path, so nothing has to convert between two of them.
    f->pts = std::llround(at * 1000000.0);
    f->time_base = AVRational{1, 1000000};
    if (fps > 0.0) f->duration = std::llround(1000000.0 / fps);
    return f;
}

}  // namespace

// ── The registry ───────────────────────────────────────────────────────────

std::string defineOutput(const std::string& id, const OutputView& v) {
    {
        std::lock_guard<std::mutex> g(lock());
        table()[id] = v;
    }
    return std::string(kPrefix) + id + "/" + rangePart(v.settings);
}

void forgetOutput(const std::string& id) {
    std::lock_guard<std::mutex> g(lock());
    table().erase(id);
}

bool resolveOutput(const std::string& src, OutputView* out) {
    const std::string prefix(kPrefix);
    if (src.compare(0, prefix.size(), prefix) != 0) return false;
    // The range is part of the token and not part of the lookup: it is there to
    // make a moved playhead a different string, and what it names is whatever
    // that id is registered as *now*. A src held by an element that has been
    // superseded therefore opens the current view, which is the same answer as
    // re-pointing it would have given.
    const std::string rest = src.substr(prefix.size());
    const size_t slash = rest.find('/');
    const std::string id = slash == std::string::npos ? rest : rest.substr(0, slash);
    std::lock_guard<std::mutex> g(lock());
    auto it = table().find(id);
    if (it == table().end()) return false;
    if (out) *out = it->second;
    return true;
}

// ── What the render turns out to be ────────────────────────────────────────

bool settleOutput(const OutputView& v, OutputFacts* facts, std::string* err) {
    OutputReader reader;
    if (!reader.open(v, err)) return false;
    if (facts) *facts = reader.facts();
    return true;
}

// ── One render, read a frame at a time ─────────────────────────────────────

OutputReader::OutputReader() = default;
OutputReader::~OutputReader() = default;

bool OutputReader::open(const OutputView& v, std::string* err) {
    ExportSettings s = v.settings;
    if (!(s.fps > 0.0)) s.fps = 25.0;

    int w = 0, h = 0;
    bool graph = false;
    source_ = sourceFor(s, v.clips, &w, &h, &graph, err);
    if (!source_) return false;

    facts_.width = w;
    facts_.height = h;
    facts_.fps = s.fps;
    facts_.start = s.startTime;
    facts_.length = std::max(0.0, s.endTime - s.startTime);
    facts_.graph = graph;

    // Zero means "until it stops", which is the honest answer for a range with
    // no end rather than a reason to refuse: a graph ends when its inputs do and
    // the canvas goes black past the end of the track stack, so an element
    // watching one has something to show either way.
    total_ = facts_.length > 0.0 ? std::max<int64_t>(1, std::llround(facts_.length * s.fps))
                                 : 0;
    n_ = 0;
    return true;
}

AVFrame* OutputReader::next(double* at) {
    if (!source_) return nullptr;
    if (total_ > 0 && n_ >= total_) return nullptr;

    const double into = double(n_) / facts_.fps;
    const double t = facts_.start + into;
    const Rgba& canvas = source_->canvasAt(t);
    // The track stack says when it has run out; a graph does not, and past the
    // end of one the canvas is black — which is the convention `canvasAt`
    // already follows and the same picture the render would write. Only asked
    // for a range with no end, where there is nothing else to stop on.
    if (total_ == 0 && source_->exhausted(t)) return nullptr;

    ++n_;
    if (at) *at = into;
    return frameOf(canvas, into, facts_.fps);
}

} // namespace ffmpegbro
