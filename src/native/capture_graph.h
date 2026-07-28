// A filter graph a device is pushed into.
//
// There are two filter graphs in this binary and the difference between them is
// which end drives. `GraphSource` (export_graph.h) is **pulled**: the render
// walks a bounded range asking "what does the output look like at t", and the
// graph is driven backwards from a sink until it yields the frame that was
// asked for. Every part of that is wrong for a device — there is no seeking a
// camera, there is no end to walk to, and the clock is the device's rather than
// the render's — so this one is **pushed**: a decoded frame goes in with its own
// timestamp on it, and whatever falls out of the sinks is what there is.
//
// That is the whole of the difference, and it is why this is a second class
// rather than a mode of the first. What the two share is what does not care
// about time: the parse (`parseFilterGraph`, one walk with the
// `-filter_hw_device` gap in it), the pad vocabulary (`PadProvider`, so that
// `pad:<label>` on a stream means the same thing in a recording as in a render)
// and the sink-per-unconsumed-output rule with its composite/`vout` naming.
//
// Four things about the push shape are load-bearing:
//
//   - **Push, then drain, and never block.** A frame goes into its buffersrc and
//     every sink is emptied with `av_buffersink_get_frame` until EAGAIN. There
//     is no `pushSome`, no starvation count and no request loop: nothing here is
//     allowed to ask an input for a frame, because the input is a camera and the
//     answer is "when it happens". A sink nobody is writing is drained and
//     dropped all the same — libavfilter holds every frame it has pushed at a
//     sink until somebody takes it, and a recording has no end for that to stop
//     growing at.
//
//   - **The graph is configured from the first frame of each feed, so it builds
//     lazily.** A decoder does not always know its own pixel format until it has
//     decoded something, which is the same reason `GraphSource::openFeed`
//     decodes a frame before describing its buffersrc. Everything that can be
//     refused from the graph text and the device's stream list is refused at
//     `open()` — before a thread exists — and only the formats wait.
//
//   - **A frame arriving before the graph is configured is queued, per feed.**
//     Two feeds settle at different moments (a camera's first picture and its
//     first block of sound are not the same instant), and the frames in between
//     are the beginning of the recording. Bounded, because a device that hands
//     over pictures and never any sound must not grow a queue for the length of
//     the recording.
//
//   - **Placement is not done here.** What leaves a sink carries the pts the
//     graph gave it; turning that into an output frame number, holding the last
//     picture over a stall and judging `-t` are the recording loop's, per sink.
//     A filter that changes the rate therefore needs nothing special: `fps=10`
//     produces frames ten times a second with timestamps that say so, and the
//     loop places them where they fall.
//
// **No hardware path.** A graph whose filters want a device is refused by name
// at `open()` rather than half-supported: `-filter_hw_device` is a decision with
// nowhere to be made on the Capture stage, and a recording that failed at
// `avcodec_open2` with a message about pixel formats would be the worst version
// of this. The shared parse is what makes that one sentence rather than a second
// implementation of the device walk.
#pragma once

#include "export_frame.h"
#include "ffmpeg_export.h"

extern "C" {
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/frame.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

class CaptureGraph : public PadProvider {
public:
    /// `sampleRate` and `channels` are what sound leaves here as — the
    /// recording's, the same ones the writer was opened for — and `scaler` is
    /// the settings' swscale preference for the conversion into RGBA.
    CaptureGraph(std::string text, int sampleRate, int channels, std::string scaler);
    ~CaptureGraph();

    CaptureGraph(const CaptureGraph&) = delete;
    CaptureGraph& operator=(const CaptureGraph&) = delete;

    /// One input the graph is allowed to read, and what it can offer.
    ///
    /// One entry per device of the session, in the order that numbers them:
    /// the first is `[0:v]` and `[0:a]`, the second `[1:v]` and `[1:a]`. It was
    /// written as a list while there could only be one, which is why a session
    /// of several needed nothing reshaped here — nothing below reads "the
    /// device", only "feed n".
    struct FeedSource {
        int index = 0;          ///< the number in `[<index>:v]`
        bool hasVideo = false;
        bool hasAudio = false;
    };

    /// Parse the graph and settle everything that does not need a frame: which
    /// input pads are read and whether anything can feed them, which output pads
    /// there are, and which of them is the composite. False with a sentence for
    /// a graph this build cannot parse, one that reads a pad nothing offers, and
    /// one whose filters want a hardware device.
    ///
    /// Called twice per recording on purpose — once on the caller's thread with
    /// a throwaway object, so that a graph that will not parse is a refusal from
    /// the call that asked for the recording rather than a job that fails a
    /// moment later, and once on the job thread by the object that is going to
    /// run. The graph, like the writer, is built where it runs.
    bool open(const std::vector<FeedSource>& inputs, std::string* err);

    /// Which feed a stream of an input goes into, or -1 when the graph does not
    /// read it — in which case that stream of the device goes straight to the
    /// writer, exactly as it did before there was a graph at all.
    int feedFor(int input, bool audio) const;

    /// Run these feeds as a **live session**: everything arriving here is on one
    /// wall clock at `rate` rather than on its own device's.
    ///
    /// Two things change in `describeFeed`, and both of them are about several
    /// inputs rather than about being live. A video buffersrc is told the rate,
    /// because the caller genuinely knows it — it is sampling every feed at the
    /// tick — and `overlay`'s framesync then has a constant-rate feed on both
    /// pads instead of two it has to guess the alignment of. And an
    /// `aresample=async` goes in between each sound buffersrc and the graph:
    /// two devices are two crystal oscillators, 48000 Hz on one of them is not
    /// 48000 Hz on the other, and stretching sound a few samples at a time to
    /// follow the timestamps is what libavfilter has that filter for. Dropping
    /// or repeating a block instead — which is what sampling sound the way the
    /// pictures are sampled would amount to — is audible.
    ///
    /// Inserted the way `GraphSource` inserts `transpose` for rotation: a
    /// filter between the buffersrc and the pad the graph text named, so the
    /// graph itself is exactly what was written.
    void setSession(AVRational rate) { session_ = rate; }

    /// Has every feed been described and the graph configured? Nothing comes out
    /// of a sink, and no pad has a size, until this is true.
    bool ready() const { return configured_; }

    /// One decoded frame into one feed, with the time base it was decoded in.
    /// The timestamps are left exactly as they arrived: what the graph is told
    /// is the device's own clock, and moving its zero is the recording loop's
    /// business at the other end.
    bool push(int feed, const AVFrame* frame, AVRational timeBase, std::string* err);

    /// This feed has no more frames. Everything still inside the graph falls out
    /// of the sinks on the next drain.
    void endFeed(int feed);
    void endAll();

    /// One frame off one output pad, handed over for as long as the callback is
    /// running and no longer.
    struct Taken {
        std::string label;
        bool audio = false;
        /// This pad is the one nobody had to name — the composite, or the mix.
        bool primary = false;
        double at = -1.0;               ///< seconds, on the sink's own clock
        const Rgba* picture = nullptr;  ///< video: at the pad's own size
        const float* samples = nullptr; ///< audio: interleaved float
        int frames = 0;
    };

    /// Empty every sink, handing each mapped pad's frames to `emit`. False when
    /// `emit` refused, which means the caller is stopping and already knows why;
    /// `err` is for a failure of this class's own.
    ///
    /// **The composite is drained first**, so that the first picture out of a
    /// configured graph is the canvas whenever there is one — which is what the
    /// recording's zero is measured from.
    bool drain(const std::function<bool(const Taken&)>& emit, std::string* err);

    // ── PadProvider ────────────────────────────────────────────────────────
    bool hasPad(const std::string& label) const override { return sinkFor(label) != nullptr; }
    bool padIsAudio(const std::string& label) const override;
    int padWidth(const std::string& label) const override;
    int padHeight(const std::string& label) const override;
    /// True where the graph says which pad the canvas is **or** where the device
    /// keeps it: a graph that does not read `[0:v]` leaves the device's picture
    /// as the composite, and refusing a composite-fed stream then would be
    /// refusing the ordinary "put a filter on the sound" recording.
    bool hasComposite() const override { return videoDirect_ || vprimary_ != nullptr; }
    bool hasMix() const override { return audioDirect_ || aprimary_ != nullptr; }
    std::vector<std::string> padLabels(bool audio) const override;
    void readPads(const std::vector<std::string>& labels) override;

    /// Whether the device's own picture (sound) goes straight to the writer,
    /// which is the case where the graph does not read that pad.
    bool videoDirect() const { return videoDirect_; }
    bool audioDirect() const { return audioDirect_; }

    /// What the composite pad settled on, once configured. Zero where the
    /// composite is the device's own picture, which the caller already knows the
    /// size and rate of.
    int compositeWidth() const;
    int compositeHeight() const;
    double compositeRate() const;

private:
    /// One buffersrc, and where it plugs in.
    ///
    /// The buffersrc does not exist until the first frame: what it has to be
    /// told is the format, and a decoder does not always know its own until it
    /// has decoded something. Until then frames go in `pending`, which is what
    /// keeps the beginning of a recording rather than throwing it away while the
    /// other feed catches up.
    struct Feed {
        int input = 0;
        bool audio = false;
        std::string label;              ///< "0:v", as the graph text writes it
        AVFilterContext* src = nullptr; ///< the graph owns it once created
        AVFilterContext* into = nullptr;
        int intoPad = 0;
        bool described = false;
        bool closed = false;
        std::vector<AVFrame*> pending;
        bool warnedFull = false;

        ~Feed();
        Feed() = default;
        Feed(const Feed&) = delete;
        Feed& operator=(const Feed&) = delete;
    };

    /// One buffersink and what one output pad needs to become a stream.
    ///
    /// The scaler and the resampler are per sink for the reason `GraphSource`'s
    /// are: two pads are two pictures of two sizes and two soundtracks of two
    /// formats, and one converter between them would hand each stream some of
    /// the other's.
    struct Sink {
        std::string label;
        bool audio = false;
        bool mapped = false;            ///< something is writing this pad
        bool ended = false;
        AVFilterContext* ctx = nullptr;
        AVFrame* frame = nullptr;

        Rgba rgba;
        SwsContext* toRgba = nullptr;

        SwrContext* swr = nullptr;
        AVSampleFormat swrFmt = AV_SAMPLE_FMT_NONE;
        int swrRate = 0;
        std::vector<float> samples;

        ~Sink();
        Sink() = default;
        Sink(const Sink&) = delete;
        Sink& operator=(const Sink&) = delete;
    };

    const Sink* sinkFor(const std::string& label) const;
    Sink* sinkFor(const std::string& label);
    /// Which sink is the composite and which is the mix, by the same rule the
    /// render uses: one pad of a kind is that kind's answer whatever it is
    /// called, and several make the name (`vout`/`aout`) the decision.
    void choosePrimaries();
    bool describeFeed(Feed& f, const AVFrame* frame, AVRational timeBase, std::string* err);
    bool configure(std::string* err);
    /// One sink's frame as RGBA at the pad's own size.
    const Rgba* pictureOf(Sink& s);
    /// One sink's frame resampled into the recording's interleaved float.
    int soundOf(Sink& s);

    std::string text_;
    int sampleRate_ = 48000;
    int channels_ = 2;
    std::string scaler_;

    AVFilterGraph* graph_ = nullptr;
    std::vector<std::unique_ptr<Feed>> feeds_;
    std::vector<std::unique_ptr<Sink>> sinks_;
    /// The session's tick rate, or `{0,1}` for an input on its own clock. See
    /// `setSession`.
    AVRational session_{0, 1};
    Sink* vprimary_ = nullptr;
    Sink* aprimary_ = nullptr;
    bool videoDirect_ = false;
    bool audioDirect_ = false;
    bool configured_ = false;
};

} // namespace ffmpegbro
