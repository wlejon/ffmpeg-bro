// The other answer to "what does the output look like at t?" — libavfilter's.
//
// `TimelineSource` composites a track stack. This parses a filter graph and
// runs it, which is what makes a filter the UI put in the graph a filter that
// actually reaches the picture. Both are `FrameSource`s (export_timeline.h) and
// the job cannot tell them apart, which is the point of the seam.
//
// Three things about it are worth knowing before changing it.
//
// **The graph pulls; the job asks.** `runExport` walks forward at a fixed
// output rate and asks for the frame at t. A filter graph does not work that
// way: frames are requested through the sink and arrive when the graph is
// ready, at whatever rate the graph settled on. What reconciles them is that a
// derived graph starts from a `color` source of the render's own size and rate
// and every `overlay` syncs to it — so the graph produces exactly the frames
// asked for, in order, and `canvasAt` is "the next one". `t` is therefore not
// used to *find* a frame, and a graph that does not carry the output's rate
// will drift against the timestamps the writer stamps. Past the end of the
// graph the canvas goes black rather than freezing on the last picture, which
// is what the track stack does when nothing covers t.
//
// **Sources are fed as decoded, not as pictures.** The graph does its own
// cropping, scaling and colour conversion — that is what it is for, and a
// conversion done on the way in would be one the graph has to undo. Rotation is
// the exception that proves it: the display matrix is not in the frames, so it
// is inserted as `transpose` filters between the buffersrc and the graph, which
// is exactly where `ffmpeg`'s own autorotate puts it.
//
// **Every input decodes from the start of its file.** `-filter_complex` with no
// `-ss` does the same, and `trim` throws away what it does not want. It is the
// honest reading of the graph and the wrong thing for a clip an hour into a
// file; when the derivation starts telling this path where each input's window
// begins, that is where the seek belongs.
#pragma once

#include "export_frame.h"
#include "export_timeline.h"
#include "ffmpeg_export.h"

extern "C" {
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libswresample/swresample.h>
}

#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

class SourceVideo;
class SourceAudio;

class GraphSource : public FrameSource {
public:
    explicit GraphSource(const ExportSettings& s);
    ~GraphSource() override;

    /// Parse the graph, open what feeds it, and negotiate formats. Separate
    /// from the constructor because a graph that will not parse is an error the
    /// render has to report, not a source that quietly produces nothing.
    bool build(std::string* err);

    /// What the graph turned out to produce. Only interesting with
    /// `ExportSettings::sizeFromGraph`, where the render has no opinion of its
    /// own and the writer has to be opened for whatever this says — a node in
    /// the middle of a graph is whatever size libavfilter made it, and nothing
    /// outside libavfilter knows what that is until the graph is configured.
    int outWidth() const { return settings_.width; }
    int outHeight() const { return settings_.height; }

    bool hasAudio() const override { return asink_ != nullptr; }
    const Rgba& canvasAt(double t) override;

    /// The pool the last video pad produces into, or null for a graph that
    /// ends in system memory. Asked of libavfilter (`av_buffersink_get_
    /// hw_frames_ctx`) rather than worked out from the chains: a graph that
    /// ends `hwupload_cuda` and one that ends `scale_cuda` are the same answer
    /// and nothing outside libavfilter knows which filters kept the picture up.
    AVBufferRef* hwFrames() const override;

    const AVFrame* nativeAt(double t) override;
    void mixInto(float* dst, double from, int frames, int rate, int channels) override;

    /// The graph has ended. Known only once a pull has come back empty, which
    /// is why `FrameSource::exhausted` is documented as a question to ask
    /// *after* `canvasAt` — the frame that discovered it is the black one this
    /// answer exists to stop being written.
    bool exhausted(double) const override { return videoEnded_; }

private:
    /// One buffersrc and the reader that fills it.
    struct Feed {
        std::string label;
        bool audio = false;
        AVFilterContext* src = nullptr;
        std::unique_ptr<SourceVideo> video;
        std::unique_ptr<SourceAudio> sound;
        /// The frame the buffersrc was configured from. Decoding it is how the
        /// formats became known, and it is still the first frame of the stream,
        /// so it is kept until the graph is configured and can take it.
        AVFrame* first = nullptr;
        bool closed = false;        // its end-of-stream has been handed over

        /// `first` is this object's, so it goes when this object does.
        /// `attachInput` builds a feed and only pushes it into `feeds_` once
        /// every link has been made, so a rotation this build has no hardware
        /// transpose for — or a link libavfilter refuses — used to drop the
        /// cloned frame on the floor. The render fails either way; a failure
        /// that also leaks is still worth not writing.
        ~Feed();
        Feed() = default;
        Feed(const Feed&) = delete;
        Feed& operator=(const Feed&) = delete;
    };

    /// The parse, in the three steps it is made of, so a device can be handed
    /// to `hwupload` between its filter being created and being initialised.
    /// See the note above the definition.
    int parseGraph(AVFilterInOut** inputs, AVFilterInOut** outputs);
    bool attachInput(AVFilterInOut* in, std::string* err);
    bool attachOutput(AVFilterInOut* out, std::string* err);
    /// Open the file behind `feed` and configure its buffersrc from the first
    /// frame — the formats have to be known before the graph is configured, and
    /// a decoder does not always know its own pixel format until it has decoded
    /// something.
    bool openFeed(Feed& feed, const ExportGraphInput& want, std::string* err);
    /// Hand each starved input one more frame. False when nothing is left to
    /// give, which is how a pull that can never succeed ends.
    bool pushSome();
    bool pushOne(Feed& feed);
    /// Pull one frame out of a sink, feeding the graph until it yields.
    int pull(AVFilterContext* sink, AVFrame* into);
    void takeSamples(const AVFrame* f);
    int available() const;

    ExportSettings settings_;
    AVFilterGraph* graph_ = nullptr;
    AVFilterContext* vsink_ = nullptr;
    AVFilterContext* asink_ = nullptr;
    // One frame each: the two sinks are pulled from independently and a shared
    // one would have the mixer overwrite the picture the writer is about to be
    // handed.
    AVFrame* vframe_ = nullptr;
    AVFrame* aframe_ = nullptr;
    std::vector<std::unique_ptr<Feed>> feeds_;

    Rgba canvas_;
    SwsContext* toRgba_ = nullptr;
    /// Where a hardware frame is brought down when the compositor's question is
    /// the one being asked of a graph that kept its pictures on the card. The
    /// arrangement is legal and slow, and the alternative — refusing — would
    /// mean a `_cuda` filter could not be previewed on a card in a node.
    AVFrame* down_ = nullptr;
    /// `-filter_hw_device`, held for the life of the graph because every filter
    /// that declared `AVFILTER_FLAG_HWDEVICE` was handed a reference to it.
    AVBufferRef* hwDevice_ = nullptr;
    bool videoEnded_ = false;

    // Sound leaves the graph in whatever format it settled on and in frames of
    // whatever length; the mixer wants interleaved floats at the render's rate,
    // a block at a time. One fifo and one resampler is the whole of the
    // difference.
    SwrContext* swr_ = nullptr;
    AVSampleFormat swrFmt_ = AV_SAMPLE_FMT_NONE;
    int swrRate_ = 0;
    std::vector<float> fifo_;
    size_t head_ = 0;
    bool audioEnded_ = false;
};

} // namespace ffmpegbro
