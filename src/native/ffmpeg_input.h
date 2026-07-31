// An input is an `-i`, not a file on a timeline.
//
// Every `avformat_open_input` in this binary used to be handed `nullptr,
// nullptr` for the format and the options, which meant three things this
// application could not say. No demuxer could be forced, so a file that probes
// wrong probed wrong for good. Nothing could set `-probesize` or
// `-analyzeduration`, which is the first thing anybody reaches for when it
// does. And an input could only ever be a path that arrived on a drop — a URL
// was unreachable although this build links openssl and srt and reports
// thirty-six input protocols.
//
// So an input is a thing now, and this is what one is: what is opened, how it
// is opened, and which part of it is used. It is deliberately *not* a clip —
// several inputs may exist with nothing on the timeline using them, and an
// input seek is not a clip in-point.
//
// **Two consumers, one struct.** The renderer is given the whole list in its
// spec and resolves each clip's index against it. Playback cannot be: bro's
// `<video>` takes a src string and the media backend is registered generically,
// so an input reaches it through the registry at the bottom of this file — the
// element is handed a token naming the input, and the backend swaps the token
// for the real URL and its options on the way into libavformat. It is a token
// rather than the path itself because a path carries none of the rest of the
// input — the demuxer, its options and the window are decisions taken while the
// file is opened, and a src string has nowhere to put them — and because bro
// resolves anything not starting with `/` or `x:` against the document, so a
// `https://…` src would otherwise become a path under `ui/`. See the
// `bro.ffmpeg.inputs` section of docs/api.md.
#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

struct AVCodecContext;
struct AVCodecParameters;
struct AVFormatContext;
struct AVFrame;
struct AVPacket;
struct AVRational;

namespace ffmpegbro {

/// One `-key value` pair, exactly as the ffmpeg command line would take it.
///
/// One struct for every bag of ffmpeg arguments in this binary: the demuxer's
/// here, the encoder's and the muxer's through the `ExportOption` alias in
/// ffmpeg_export.h. They are applied the same way — `av_opt_set` /
/// `AVDictionary` — and an unknown key is an error in all of them.
struct KeyValue {
    std::string key;
    std::string value;
};

/// One `-i`.
///
/// Everything here appears *before* the `-i` on a command line, which is not a
/// piece of trivia about argument order: these are the decisions taken while
/// the file is being opened, and none of them can be taken afterwards.
struct MediaInput {
    /// The path or URL `-i` is given. A local file, or anything a protocol in
    /// `bro.ffmpeg.protocols.input` can reach — `https://`, `srt://`, `udp://`.
    std::string path;

    /// The demuxer, forced: `-f mov` before `-i`. Empty lets libavformat probe,
    /// which is right nearly always and wrong in exactly the cases this field
    /// exists for — a raw stream with no header to probe, a container whose
    /// first bytes lie, a device.
    std::string format;

    /// Demuxer and protocol options. `-probesize`, `-analyzeduration`,
    /// `-fflags`, and every private option of the demuxer and of the protocol
    /// the URL names, since libavformat passes what it does not recognise down
    /// to the AVIO layer.
    ///
    /// **An unknown key is an error, not a shrug.** `avformat_open_input`
    /// hands back the entries nothing consumed, and this is the one place in
    /// libav where "was that option used?" has a real answer — so it is asked.
    std::vector<KeyValue> options;

    /// What the *decoders* reading this input are opened with — `-skip_frame`,
    /// `-skip_loop_filter`, `-thread_type`, `-lowres`, and every private option
    /// of whichever decoder libavcodec picks.
    ///
    /// **A decoder belongs to an input, which is why these live here.** ffmpeg
    /// writes them before the `-i` for the same reason it writes `-probesize`
    /// there: they are decisions taken while the file is being opened, and the
    /// decoder they configure is the one that input's packets go through. A
    /// render that opened one file twice with two different decoder bags would
    /// be describing two files, which is the argument the option bag above is
    /// already built on.
    ///
    /// They are applied wherever a decoder is opened for this input — both
    /// export readers and playback — so `-skip_frame nokey` is the same
    /// decision on the timeline and in the file that comes out. An unknown key
    /// stops the open with the key named, exactly as an unknown demuxer option
    /// does: `avcodec_open2` hands back what nothing consumed.
    std::vector<KeyValue> decoderOptions;

    /// `-hwaccel cuda`: decode this input on a device rather than on the CPU.
    ///
    /// **A decoder belongs to an input, and so does the device it runs on.**
    /// ffmpeg writes `-hwaccel` in front of the `-i` for the same reason it
    /// writes `-skip_frame` there — it is a decision taken while the file is
    /// being opened, and it configures the decoder that input's packets go
    /// through. Two clips cut from one file cannot be decoded one way and the
    /// other.
    ///
    /// **Unavailable is a refusal, not a fallback.** A type that is compiled in
    /// and absent, or a codec the card has no decoder for, stops the open with
    /// the reason named. Silently decoding in software would be a render that
    /// succeeded while ignoring what it was told, and on a machine where
    /// software decode is the *faster* path it would never be noticed. See
    /// ffmpeg_hardware.h.
    std::string hwaccel;

    /// `-hwaccel_device 0`: which one. An index for CUDA, an adapter number for
    /// D3D11, a node path for VAAPI. Empty is the default device, which is what
    /// a machine with one card wants and what a machine with two gets by
    /// accident.
    std::string hwaccelDevice;

    /// `-hwaccel_output_format cuda`: **leave the frames on the card**.
    ///
    /// ffmpeg's own vocabulary for the same decision. Empty — which is what
    /// `-hwaccel cuda` alone means — downloads every frame into system memory
    /// as it is decoded, because everything downstream (the compositor, a
    /// software filter, bro's renderer) wants pixels it can touch. Set, the
    /// frames stay where they were decoded and only a graph made of
    /// `_cuda`/`_qsv` filters, or an `hwdownload`, can read them; a hardware
    /// encoder at the far end then never brings the picture down at all.
    ///
    /// **Measured, and the answer is not the one the folklore gives.** The
    /// readback is 3–4% of a hardware decode's wall clock on this machine — it
    /// is not the cost. The *decode* is: NVDEC pulled a frame at a time is
    /// 2.6× slower than libavcodec threaded across 32 cores at 4K and 3.4×
    /// slower at 1080p, so `-hwaccel` on an input is a loss whatever this field
    /// says. What wins is the encoder, which is a decision about a stream and
    /// not about an input. The numbers, and what follows from them, are in
    /// docs/manual/card.md.
    std::string hwaccelOutputFormat;

    /// `-ss` before `-i`: where this input starts. The input's clock is
    /// rewritten so that this instant is its zero, which is what makes it a
    /// different thing from a clip's in-point — trimming a clip picks a moment
    /// out of an input, and this decides what the input *is*.
    double ss = 0.0;

    /// `-t`: how much of the input is used, from `ss`. Zero is all of it.
    /// `-to` is the same decision stated as an end time; the UI converts.
    double duration = 0.0;

    /// `-itsoffset`: shift this input's timestamps. Positive delays it — the
    /// picture arrives later — which is how a camera and a separately recorded
    /// soundtrack are lined up.
    double itsoffset = 0.0;

    /// `-stream_loop`: how many *more* times to read this input after the
    /// first. 0 is once through, -1 is forever.
    ///
    /// This is the one thing in this struct libavformat has never heard of.
    /// `-framerate`, `-start_number`, `-pattern_type` and `-loop` — everything
    /// that makes a numbered run of files or a single still into an input —
    /// are options of the `image2` demuxer and travel in the bag above, which
    /// is why an image sequence needed nothing added here. Looping a *stream*
    /// is not: ffmpeg's own CLI implements it by seeking the input back to the
    /// start when it ends and shifting every timestamp forward by one pass,
    /// and `InputLoop` below is this binary's one copy of that arithmetic.
    int streamLoop = 0;

    bool operator==(const MediaInput& o) const {
        return path == o.path && format == o.format && ss == o.ss &&
               duration == o.duration && itsoffset == o.itsoffset &&
               streamLoop == o.streamLoop && hwaccel == o.hwaccel &&
               hwaccelDevice == o.hwaccelDevice &&
               hwaccelOutputFormat == o.hwaccelOutputFormat &&
               same(options, o.options) && same(decoderOptions, o.decoderOptions);
    }

private:
    static bool same(const std::vector<KeyValue>& a, const std::vector<KeyValue>& b) {
        if (a.size() != b.size()) return false;
        for (size_t i = 0; i < a.size(); ++i)
            if (a[i].key != b[i].key || a[i].value != b[i].value) return false;
        return true;
    }
};

/// Open a decoder for a stream of this input, with the input's decoder options
/// on it.
///
/// One place, for the reason `openInput` is one place: three things in this
/// binary open decoders — the two export readers and the playback source — and
/// an option bag applied in two of them and forgotten in the third is a setting
/// that works on the timeline and not in the file. An unknown key is refused
/// with the key named; `avcodec_open2` hands back what nothing consumed, which
/// is the only place libavcodec will say whether an option was used.
///
/// `*out` is left null on failure. `threaded` asks for the frame/slice
/// threading every decoder here has always been opened with; a `thread_type` in
/// the bag still wins, because the bag is applied afterwards.
bool openDecoder(AVCodecContext** out, const AVCodecParameters* par,
                 AVRational pktTimeBase, const MediaInput& in, bool threaded,
                 std::string* err);

/// Do this input's frames stay on the device once decoded?
///
/// One rule in one place, because four things ask and each of them would get
/// it slightly differently: the two export readers (which download unless the
/// graph is going to take hardware frames), the playback source (which always
/// downloads, since bro's renderer wants planes), and the printed command.
/// `-hwaccel` alone is ffmpeg's "decode on the card and bring it back";
/// `-hwaccel_output_format` is what leaves it there.
bool hwFramesStayUp(const MediaInput& in);

/// Bring a hardware frame down into system memory, keeping its timestamps.
///
/// `av_hwframe_transfer_data` copies pixels and nothing else — not the pts, not
/// the colour tags, not the frame's own metadata — so a download that forgot
/// `av_frame_copy_props` produces pictures with no clock, which reads as a
/// decoder that has stopped reporting timestamps rather than as a missing line
/// here. `*frame` is replaced by the software copy on success and left alone on
/// failure. `scratch` is the caller's spare frame, reused so a download does
/// not allocate per picture.
bool downloadFrame(AVFrame** frame, AVFrame** scratch, std::string* err);

/// A blocking open, made stoppable and given a deadline.
///
/// **`AVIOInterruptCB` is the only way to interrupt an open in progress**, and
/// that is why this exists rather than a thread somebody kills. libav polls the
/// callback from inside every wait it does — `ff_network_wait_fd_timeout` calls
/// `ff_check_interrupt` every 100ms while a `connect()`, a TLS handshake or a
/// read is outstanding — and a non-zero answer aborts the operation with
/// `AVERROR_EXIT`. Nothing else reaches a socket libav is sitting on: killing
/// the thread would leave the descriptor, the SSL context and libavformat's own
/// allocations behind.
///
/// **The deadline and the stop are the same mechanism**, deliberately, because
/// a timeout that expired and a person who pressed Stop have to abort the open
/// in the same way or the two would behave differently in exactly the case
/// nobody can reproduce. `expired()` and `stopped()` then say which it was, so
/// the message can.
///
/// **A protocol's own timeout option is not what this is.** Asked of libav
/// rather than assumed — `avio_protocol_get_class(name)`, the same walk
/// `bro.ffmpeg.protocolOptions` reports — the answer in this build is that
/// `tcp`, `udp`, `udplite`, `rtp`, `ftp` and the six `rtmp` protocols carry a
/// `timeout`, `srt` carries `connect_timeout`/`timeout`/`listen_timeout`, and
/// **`http`, `https` and `tls` carry none at all**: they open a `tcp`
/// URLContext underneath and pass their dictionary down to it. `rw_timeout` is
/// on the URLContext class rather than on any protocol, so it appears in no
/// option table here and covers transfers after a connect rather than the
/// connect. So a timeout written as an option would be absent for the protocol
/// a URL in this application overwhelmingly names, and would still not cover
/// `avformat_find_stream_info`. The deadline covers the whole open, for every
/// protocol, and there is one of it.
///
/// **What it cannot interrupt is name resolution.** `getaddrinfo` is a blocking
/// call in the C library with no callback in it, so a host that resolves slowly
/// blocks until the resolver gives up whatever this says. That is the reason
/// the open is on a thread of its own as well as behind a deadline: the
/// deadline is what makes it end, and the thread is what stops it taking the
/// window with it.
///
/// **And what it does not reach at all is the first half of a device open.**
/// This is measured rather than assumed, and the measurement is the reason the
/// thread is not an optimisation here but the whole mechanism. A libavdevice
/// demuxer carries `AVFMT_NOFILE`, so `avformat_open_input` opens no AVIO layer
/// for it and goes straight into the demuxer's own `read_header` — which on
/// this platform is COM, DirectShow graph building and the driver, none of
/// which has ever heard of `ff_check_interrupt`. Counting the callback's calls
/// on this machine: `dshow` opening a real audio device takes **400 ms and
/// polls this zero times**, `gdigrab desktop` 0.1 ms and zero, `lavfi
/// testsrc` 1.3 ms and zero. An already-aborting callback does not shorten any
/// of them — the 400 ms dshow open still runs to completion.
///
/// `avformat_find_stream_info` *is* covered, because libavformat checks the
/// callback between reads there: 520 ms of the dshow open, 92 ms of the
/// gdigrab one, 6 ms of the lavfi one, and it aborts in 0.04 ms when told to.
/// That check is at the *top* of its loop, before it asks whether anything is
/// still unknown, so it happens at least once however little there is to
/// analyse — counted on `lavfi testsrc`, whose codec parameters are known
/// before a packet is read, it is two polls on every run. So for a device the
/// deadline and the Stop cover the second half of an open and not the first —
/// 57% of a `dshow` open and 99.9% of a `gdigrab` one, on those numbers — and
/// **a Stop that arrives during `read_header` stops the waiting rather than the
/// open**. `probe_async.h` reports which of the two a caller is holding, so
/// nothing on screen may claim more than this does.
///
/// No device demuxer in this build offers a timeout to put in the option bag
/// instead: asked of libav rather than assumed, the only option with "time" in
/// its name across `dshow`, `gdigrab`, `lavfi` and `vfwcap` is dshow's
/// `use_video_device_timestamps`, which is about which clock a frame carries.
class OpenWatch {
public:
    /// Give up `seconds` from now. Zero or less is no deadline, which is what
    /// every caller that is not opening a URL wants.
    ///
    /// **"Now" is `av_gettime_relative()`, which is the system tick and not a
    /// microsecond clock.** Measured on this platform it steps in 0.5–1.5 ms —
    /// it is `GetSystemTimeAsFileTime` underneath — so a deadline shorter than
    /// one step may be read back inside the same tick it was armed in and be,
    /// truthfully, not yet passed. Every real caller asks for seconds and none
    /// of this can matter to one; it is written down because a *test* that
    /// asked for a microsecond found out the hard way, and because "expired"
    /// below is defined in terms of what this clock says.
    void expireIn(double seconds);

    /// Ask the open in progress to abort. Safe from any thread, which is the
    /// point — the UI thread presses it while the open thread is inside libav.
    void stop();

    bool stopped() const { return stop_.load(std::memory_order_relaxed); }

    /// True once the deadline has passed *and the callback has seen it*. Read
    /// after a failed open to say why it failed; a deadline that expired while
    /// nothing was blocking is not what stopped anything.
    ///
    /// **What that guarantees is a conjunction, and the second half is the one
    /// that surprises.** A deadline may pass during a stretch libav never polls
    /// — a device's `read_header`, `getaddrinfo` — and it may pass between two
    /// polls of a stretch that is over before the next one, which is what a
    /// deadline shorter than the clock's own step amounts to. Both are the same
    /// answer: nothing was interrupted, so nothing here claims to have
    /// interrupted it, and the open reports whatever it actually did.
    bool expired() const { return expired_.load(std::memory_order_relaxed); }

    /// What libav polls. Public because `openInput` hands it over; there is no
    /// reason for anything else to call it.
    static int poll(void* opaque);

private:
    std::atomic<bool> stop_{false};
    std::atomic<bool> expired_{false};
    std::atomic<int64_t> deadline_{0};   ///< av_gettime_relative() µs, 0 for none
};

/// Open one input, the way its `-f` and its option bag say to.
///
/// Everything that opens a demuxer in this binary goes through here, so there
/// is one place where a forced format is looked up, one place where the option
/// bag becomes an `AVDictionary`, and one place where an option nothing
/// consumed becomes a refusal naming the key. `avformat_find_stream_info` is
/// run too, because every caller then does it and a probe that has not run it
/// answers about a container rather than about a file.
///
/// `watch` is optional and null for every caller that is already off the UI
/// thread — a render, a recording, a playback source. Passed, the context is
/// allocated here rather than by `avformat_open_input` so that
/// `interrupt_callback` is set *before* the first byte is read, and the same
/// callback then covers `avformat_find_stream_info`, which is the half of an
/// open that reads from the network for as long as it likes.
///
/// On failure `*err` says what and `*out` is left null. An open that was
/// stopped or that ran out of time says so in place of libav's `Immediate exit
/// requested`, which names the mechanism rather than the reason.
bool openInput(AVFormatContext** out, const MediaInput& in, std::string* err,
               OpenWatch* watch = nullptr);

/// The window `openInput` did not apply: the reader's own clock, in seconds.
///
/// `ss` and `itsoffset` are not demuxer options — libav has no idea about
/// either — so they are arithmetic on whatever reads the file. This is the one
/// implementation of that arithmetic: the offset to subtract from a container
/// timestamp so that the input's zero is where the input says it is.
double inputEpoch(const MediaInput& in, double containerStart);

/// Where this input ends on its own clock, or 0 for "at the end of the file".
double inputLimit(const MediaInput& in);

/// The same moment `inputEpoch` measures against, as `av_seek_frame` wants to
/// hear it: a timestamp in one stream's time base.
///
/// **A demuxer's seek clock is not its index's clock**, and mp4 is where that
/// costs an afternoon. `mov_read_seek` takes a timestamp "relative to the edit
/// list" — presentation time, counting from the first frame on screen — and
/// then subtracts the edit-list offset itself before searching the index, whose
/// entries are raw decode timestamps. Handed an index timestamp verbatim it
/// searched two frames early, found no keyframe there, walked *backwards* to
/// the start of the file, and returned success: a cut two seconds in silently
/// copied the whole thing. So the target is the moment as the timeline means
/// it, with only the input's own `-ss`/`-itsoffset` on it and none of the
/// stream's own origin.
///
/// Every seek this renderer makes is `AVSEEK_FLAG_BACKWARD`, which is what
/// makes that safe rather than merely correct: landing early costs reading a
/// few packets that are then dropped, and landing late loses content nothing
/// can get back. Two readers and the subtitle path ask, which is why it is
/// here rather than beside any one of them.
int64_t inputSeekTarget(AVRational timeBase, const MediaInput& in, double at);

/// True when this input goes on producing frames for as long as it is asked to.
///
/// `-loop 1` on an image and `-stream_loop -1` on anything make an input with
/// no length of its own: libavformat reports one pass — for a still, one frame
/// — and everything above the model believes it, because everything above the
/// model was written when a duration was a fact discovered by probing.
///
/// It is not a fact here. **`-t` is the only thing that can say how long such
/// an input is, and it is a decision rather than a measurement**, which is
/// exactly why it lives on the input beside the options that made it endless
/// and is not invented somewhere further up to make a timeline comfortable.
/// `probeMedia` and the playback source both ask this before believing a
/// container's duration; see `inputDuration`.
bool inputIsEndless(const MediaInput& in);

/// How long this input is, given what the container said its own length was.
///
/// One rule in one place, because a clip's length comes from it and the
/// timeline, the renderer and playback each ask separately. Three cases:
///
///   - an ordinary input is as long as it measured, cut down by the window;
///   - a finite `-stream_loop` is that length over again a known number of
///     times, which is measurable and is measured;
///   - an input that never ends — `-loop 1`, `-stream_loop -1` — has `-t` as
///     the whole of its length, and **zero when there is no `-t`**. Zero means
///     nobody knows, which is the honest answer and not a number to paper over.
double inputDuration(const MediaInput& in, double containerDuration);

/// `-stream_loop`, folded into the packet read.
///
/// Three things in this binary read packets — the two export readers and the
/// playback source — and looping is arithmetic on timestamps rather than a
/// demuxer feature, so without a shared implementation each would get it
/// slightly differently and a soundtrack would end up shifted by a different
/// amount from the picture it belongs to.
///
/// A pass is as long as the container says, or as long as the furthest packet
/// seen if it will not say — which is what makes this work on the formats that
/// report no duration at all.
class InputLoop {
public:
    /// What the input asked for, and how long one pass is. Safe to call with
    /// `streamLoop == 0`, where every call below is `av_read_frame` verbatim.
    void configure(AVFormatContext* fmt, const MediaInput& in);

    bool looping() const { return passes_ != 1; }

    /// `av_read_frame`, plus the seek back and the timestamp shift when a pass
    /// ends and another is owed. Returns libav's own code, so `AVERROR_EOF`
    /// still means the input has genuinely ended.
    int read(AVFormatContext* fmt, AVPacket* pkt);

    /// Where a seek to `seconds` on the input's continuous clock actually
    /// lands: which pass it is in, and the moment within that pass. Call before
    /// seeking and seek to `*within` instead.
    void seekTo(double seconds, double* within);

private:
    int64_t passes_ = 1;      ///< total passes; 0 is forever
    int64_t done_ = 0;        ///< passes finished
    int64_t shift_ = 0;       ///< AV_TIME_BASE units added to every timestamp
    int64_t passLen_ = 0;     ///< AV_TIME_BASE units, 0 until something is known
    int64_t furthest_ = 0;    ///< the end of the furthest packet seen, same units
};

// ── The playback registry ──────────────────────────────────────────────────
//
// `<video src>` is a string and the media backend is registered generically,
// so the only way an input's options can reach playback is for the string to
// name the input. `defineInput` returns the token to hand the element;
// `resolveToken` is what the backend calls on the way in.
//
// Process-global and mutex-guarded, because a Worker is another realm on
// another thread and `bro.media`'s filmstrip decode runs there against the
// same inputs.

/// Register (or replace) an input under `id`. Returns the token to use as a
/// `<video>` src, a `bro.media` path, or anywhere else bro takes a media path.
std::string defineInput(const std::string& id, const MediaInput& in);

/// Forget one. Nothing already open is disturbed; a token that no longer
/// resolves opens as the literal string it is, which fails the way a missing
/// file does.
void forgetInput(const std::string& id);

/// Token → input. False when `src` is not one of ours, which is the ordinary
/// case: a plain path stays a plain path.
bool resolveToken(const std::string& src, MediaInput* out);

/// The token for an id, without registering anything. One place that knows the
/// shape of the string.
std::string inputToken(const std::string& id);

} // namespace ffmpegbro
