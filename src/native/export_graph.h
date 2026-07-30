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
// **A subtitle pad is the other exception, and it is not a libavfilter link at
// all.** libavfilter has no subtitle input: `[0:s]` reaching an `overlay` is
// ffmpeg's own sub2video mechanism, which decodes the cues and paints them into
// RGBA frames fed to an ordinary `buffer` source. `SubtitleSource`
// (export_sub2video.h) is that, and a feed carrying it is a *picture* feed as far
// as everything below here is concerned. A **text** track on such a pad is
// refused when the input is opened, because painting characters is libass's job
// and the `subtitles` filter is where it is done.
//
// **Every input decodes from the start of its file.** `-filter_complex` with no
// `-ss` does the same, and `trim` throws away what it does not want. It is the
// honest reading of the graph and the wrong thing for a clip an hour into a
// file; when the derivation starts telling this path where each input's window
// begins, that is where the seek belongs.
//
// **A graph ends in as many pads as it ends in.** One sink is opened per
// unconsumed output, and which of them is the composite is a rule rather than a
// position: with one video pad it is that pad whatever it is labelled — which
// is every render written before this and every test in the suite — and with
// several it is the one labelled `vout`, the name the derivation has always
// given it. The rest are addressable by name, as `pad:<label>` on a stream, and
// so is the composite: both names reach one sink, which for a picture is simply
// the same picture read twice.
//
// **One tick advances every video sink together**, in `canvasAt`. They come out
// of one graph and a pad pulled at a different moment from the canvas is a
// stream whose frames are out of step with it. Nothing is converted until a pad
// is actually asked for, so an unmapped sink costs a pull and no pixels — and it
// *is* pulled: a sink nobody reads holds every frame the graph pushes at it, and
// the memory grows with the length of the render. An unmapped sound pad is
// drained the same way and never blocks, because driving the inputs on behalf of
// a pad nobody is writing would read a file to throw it away.
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
class SubtitleSource;

/// `avfilter_graph_parse2`, in the three steps it is made of, so that a device
/// can be handed to the filters that need one *between* being created and being
/// initialised.
///
/// **`hwupload` refuses to initialise without a device**, and there is nowhere
/// to put one: the filter takes no argument that could name it and reads
/// `AVFilterContext::hw_device_ctx`, which does not exist until the filter does.
/// `avfilter_graph_parse2` creates and initialises in one call, so a device
/// assigned after it has already come too late — "A hardware device reference is
/// required to upload frames to", from inside a parse, with nothing in the
/// message about which filter meant it.
///
/// The segment API is the seam ffmpeg's own CLI uses for exactly this, and this
/// is `graph_parse()` in `ffmpeg_filter.c` written out. With no device named it
/// is `avfilter_graph_parse2` in three lines instead of one, which is why there
/// is no fast path here to disagree with.
///
/// **One parse, two callers.** `GraphSource` pulls its graph and `CaptureGraph`
/// pushes into one; what they share is that the graph is a graph, and a second
/// copy of this walk would be a second place for the device gap to be got wrong.
///
/// `wantsDevice`, when given, changes what happens to a graph that needs a
/// device and was handed none: the parse stops before the filters are
/// initialised and the first such filter's name is written there, so a caller
/// with no hardware path at all can say so plainly. Null — which is what the
/// render passes — leaves libavfilter to answer in its own words.
int parseFilterGraph(AVFilterGraph* graph, const std::string& text, AVBufferRef* hwDevice,
                     AVFilterInOut** inputs, AVFilterInOut** outputs,
                     std::string* wantsDevice = nullptr);

class GraphSource : public FrameSource, public PadProvider {
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

    bool hasAudio() const override { return aprimary_ != nullptr; }
    const Rgba& canvasAt(double t) override;

    /// This tick's picture for a named pad. See `FrameSource::padAt`.
    const Rgba* padAt(const std::string& label) override;
    bool padMixInto(const std::string& label, float* dst, double from, int frames, int rate,
                    int channels) override;

    // ── what the graph turned out to end in ────────────────────────────────
    //
    // Asked by the job after `build()`, because a stream fed from a pad is
    // opened for the size that pad settled on and nothing outside libavfilter
    // knows what that is until the graph is configured. Every refusal that
    // could be made from these is made there, before the writer opens a file:
    // a label that names no pad, a picture pad in a sound stream, a composite
    // asked of a graph that never said which pad it was.

    bool hasPad(const std::string& label) const override { return sinkFor(label) != nullptr; }
    bool padIsAudio(const std::string& label) const override;
    int padWidth(const std::string& label) const override;
    int padHeight(const std::string& label) const override;

    /// Whether this graph says which of its pads is the composite (or the mix).
    /// False only for a graph with several pads of that kind and none of them
    /// labelled `vout` (or `aout`) — where the honest answer is that nobody
    /// said, and a stream asking for the composite has to be refused by name.
    bool hasComposite() const override { return vprimary_ != nullptr; }
    bool hasMix() const override { return aprimary_ != nullptr; }

    /// Every output pad of a kind, in the order the graph declared them. For a
    /// refusal that has to say what there was instead.
    std::vector<std::string> padLabels(bool audio) const override;

    /// Which pads the render is going to read by name.
    ///
    /// Told rather than discovered, because the difference matters before the
    /// first frame: an unmapped sound pad is drained and thrown away on every
    /// tick, and finding out that somebody wanted it after the first tick has
    /// already dropped its first frames is too late. The composite and the mix
    /// are always read and need not be named.
    void readPads(const std::vector<std::string>& labels) override;

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
    ///
    /// It is about the composite, as it always was. A graph that never said
    /// which pad that is has no canvas to run out of, so the question falls
    /// back to every picture pad having ended — which is the same statement
    /// about a render whose every video stream comes from a pad.
    bool exhausted(double) const override;

private:
    /// One buffersrc and the reader that fills it.
    struct Feed {
        std::string label;
        bool audio = false;
        AVFilterContext* src = nullptr;
        std::unique_ptr<SourceVideo> video;
        std::unique_ptr<SourceAudio> sound;
        /// A subtitle stream painted into pictures — see export_sub2video.h. It
        /// feeds an ordinary video `buffer`, so `audio` is false for one and
        /// everything past the push treats it as the picture feed it is; what
        /// makes it its own member is that there is no decoder, no scaler and no
        /// rotation in it, only cues.
        std::unique_ptr<SubtitleSource> cues;
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

    /// One buffersink and everything one output pad of the graph needs to
    /// become a stream: this tick's frame, the RGBA it is converted into when
    /// somebody asks, and — for a sound pad — its own resampler and fifo.
    ///
    /// **The resampler and the fifo are per sink and not shared**, which is the
    /// whole of what telling two sound pads apart amounts to: one fifo between
    /// them would hand each stream alternate blocks of the other's samples, and
    /// what that writes is two tracks that are each half of both.
    struct Sink {
        std::string label;
        bool audio = false;
        /// Something reads this pad by name. False for a pad the render is not
        /// writing, which is pulled and dropped rather than left to fill up.
        bool mapped = false;
        AVFilterContext* ctx = nullptr;
        bool ended = false;

        /// This tick's frame, or a scratch frame to pull sound into.
        AVFrame* frame = nullptr;
        /// Where a hardware frame is brought down when a pad on a card is
        /// asked for as pixels. Per sink, because two pads can be on two
        /// different devices and one buffer between them would swap pictures.
        AVFrame* down = nullptr;

        // video: converted on demand, so a sink nobody reads costs a pull.
        Rgba rgba;
        bool converted = false;
        SwsContext* toRgba = nullptr;

        // audio: whatever the pad settled on, resampled into the render's
        // interleaved float and buffered until the job asks for a block.
        SwrContext* swr = nullptr;
        AVSampleFormat swrFmt = AV_SAMPLE_FMT_NONE;
        int swrRate = 0;
        std::vector<float> fifo;
        size_t head = 0;

        ~Sink();
        Sink() = default;
        Sink(const Sink&) = delete;
        Sink& operator=(const Sink&) = delete;
    };

    bool attachInput(AVFilterInOut* in, std::string* err);
    bool attachOutput(AVFilterInOut* out, std::string* err);
    /// Which sink is the composite and which is the mix. See the note above
    /// the definition: one pad of a kind is that kind's answer whatever it is
    /// called, and several make the name the decision.
    void choosePrimaries();
    const Sink* sinkFor(const std::string& label) const;
    Sink* sinkFor(const std::string& label);
    /// Pull one frame into every picture sink and empty every sound sink
    /// nobody is reading. The one place the graph is advanced.
    void tick();
    /// One sink's frame, converted into `dst`: a row-by-row copy when it is
    /// already RGBA at that size, the scaler when it is not, and a download
    /// first when it is still on a card. False when there was nothing to
    /// convert or the conversion failed, which the callers draw as black.
    bool convertInto(Sink& s, Rgba& dst, SwsContext** scaler);
    /// This sink's picture as RGBA at the pad's own size, converted at most
    /// once per tick and black once the pad's branch has ended.
    const Rgba* padPicture(Sink& s);
    /// Add this sink's next `frames` samples into `dst`, pulling the graph as
    /// far as it takes. The mix and a named pad are the same act.
    void fillAudio(Sink& s, float* dst, int frames);
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
    int pull(Sink& sink, AVFrame* into);
    /// Sound out of one sink and into its own fifo, resampled to the render's
    /// rate and channel count on the way.
    void takeSamples(Sink& s, const AVFrame* f);
    int available(const Sink& s) const;

    ExportSettings settings_;
    AVFilterGraph* graph_ = nullptr;
    /// One per unconsumed output pad, in the order the parse declared them.
    std::vector<std::unique_ptr<Sink>> sinks_;
    /// The composite and the mix, or null where the graph did not say which
    /// pad that is. Pointers into `sinks_`, which nothing adds to after
    /// `build()`.
    Sink* vprimary_ = nullptr;
    Sink* aprimary_ = nullptr;
    std::vector<std::unique_ptr<Feed>> feeds_;

    /// The composite, at the render's size. Separate from the primary sink's
    /// own buffer because the two are not always the same picture: under
    /// `sizeFromGraph` the canvas has a sixteen-pixel floor the pad does not,
    /// and a pad read *both* as the composite and by name is one sink asked
    /// for two sizes.
    Rgba canvas_;
    SwsContext* toCanvas_ = nullptr;
    /// `-filter_hw_device`, held for the life of the graph because every filter
    /// that declared `AVFILTER_FLAG_HWDEVICE` was handed a reference to it.
    AVBufferRef* hwDevice_ = nullptr;
};

} // namespace ffmpegbro
