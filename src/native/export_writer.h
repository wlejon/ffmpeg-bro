// The output file: encoders, and the muxer they feed.
//
// Everything past the compositor. The canvas arrives as RGBA and leaves as
// packets in a container, and the two interesting properties of that journey
// are both about honesty:
//
//   - **Capabilities are queried, never assumed.** Which pixel format, which
//     sample format, which sample rate: asked of the encoder, because a build
//     without an encoder should say so rather than fail at the last step.
//   - **An option the encoder does not have is an error, not a shrug.** The
//     settings past the codec are `-key value` pairs applied with av_opt_set
//     and AV_OPT_SEARCH_CHILDREN — the same path the ffmpeg command line uses
//     — so anything documented for `ffmpeg -c:v libx265 -x265-params …` works
//     here unchanged, and a render that succeeds while ignoring half of what
//     it was told is the worst of the three outcomes.
//
// **One writer is one muxer, which is not the same thing as one file.** It was
// for a long time, and everything about reporting what a render produced
// assumed it: a path, stat'd at the end. Four muxers break that assumption and
// they are the whole of chunk 13 — `segment` and `image2` write a numbered run,
// `hls` and `dash` write a run and a playlist that names it, and `tee` writes
// the same packets to several destinations at once. None of them is a second
// kind of writer; each is a muxer opening files this class never asked for.
//
// So the question "what did this render write" is asked of libavformat rather
// than guessed from the filename. `AVFormatContext::io_open` is the callback
// libavformat routes *every* output through — the primary file, every segment,
// every DASH chunk, every `tee` slave, every numbered picture — and it is the
// same seam ffmpeg's own CLI overrides. Hooking it gives the count, the names
// and the sizes for nothing, and it is the only version of this that does not
// go stale the first time a muxer numbers its files differently.
//
// A destination that is a **URL** rides the same seam: `avio_open2` takes the
// protocol's options, and libavformat hands a muxer's leftovers down to the
// AVIO layer exactly as it does at the reading end — which is why the two
// travel in one `formatOptions` bag here and are split apart in `open()`.
//
// **One file is N streams.** It used to be exactly one video stream and one
// audio stream, with two members for each and `avformat_new_stream` called
// twice in two functions that were nearly the same function. Everything that a
// muxer can hold and this application could not say — a second audio track, a
// language, a disposition, a fourcc, a font travelling beside a subtitle —
// followed from that one assumption, so what is here now is a vector of `Out`,
// each of which is a description (`ExportStream`) plus whatever apparatus its
// kind needs to get a frame into the file. `writeVideo` feeds every video
// stream mapped to the composite and `writeAudio` feeds every audio stream
// mapped to the mix, which is why the job above did not change at all.
#pragma once

#include "export_frame.h"
#include "ffmpeg_export.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/eval.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <cstdio>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace ffmpegbro {

class CopyStreams;
class SubtitleStreams;

class Writer {
public:
    ~Writer();

    /// `copies` is the render's packet path — the streams fed from a demuxer
    /// rather than from the compositor. It is built *before* this is called
    /// because a copied stream is described to the muxer out of its input
    /// stream's own parameters, and there is nowhere else to get them from.
    /// Null is a render with no copied stream in it, which is nearly all of
    /// them.
    /// `subs` is the render's decoded-subtitle path, for the same reason
    /// `copies` is here: a subtitle stream's encoder is opened *against its
    /// decoder* — the ASS header carries the styles and the frame size carries
    /// where a `mov_text` box goes — and there is nowhere else to get either.
    /// `hwFrames` is the pool the composited picture is going to arrive in, or
    /// null for the ordinary render whose canvas is RGBA in system memory. Given
    /// here rather than discovered later because an encoder that takes frames
    /// from a pool is *opened* against that pool — `avcodec_open2` builds its
    /// surfaces from it — and by the time the first frame arrives the header
    /// has gone down.
    bool open(const ExportSettings& s, bool wantAudio, std::string* err,
              CopyStreams* copies = nullptr, SubtitleStreams* subs = nullptr,
              AVBufferRef* hwFrames = nullptr);

    /// Encode one composited canvas into every video stream mapped to the
    /// composite. `index` is the output frame number, which is the whole
    /// timestamp: a fixed frame rate is what makes the result a file every
    /// editor will accept.
    bool writeVideo(const Rgba& canvas, int64_t index, std::string* err);

    /// True when this render's pictures never come down: every video stream fed
    /// from the composite was opened against the frames context `open()` was
    /// given, and the job should be calling `writeVideoFrame` instead.
    ///
    /// It is all of them or none. A file with one hardware video stream and one
    /// software one would need the picture in both places at once, which is a
    /// download per frame done quietly on behalf of a render that asked for the
    /// opposite — so `open()` refuses it and says which stream is the odd one.
    bool takesNativeFrames() const { return native_; }

    /// Encode one picture exactly as it left the graph — on the card, in the
    /// pool the encoder was opened against. No scaler, no colour conversion and
    /// no copy: the frame goes from `av_buffersink_get_frame` to
    /// `avcodec_send_frame` and the only things written on it are the ones that
    /// are not pixels (the timestamp, the forced keyframe, the field order).
    bool writeVideoFrame(AVFrame* frame, int64_t index, std::string* err);

    /// Take mixed interleaved float samples, for every audio stream mapped to
    /// the mix. They are buffered per stream and handed to each encoder in
    /// exactly the frame size it asked for, because AAC wants 1024 samples at a
    /// time and the video loop produces however many one frame covers — and
    /// because two encoders in one file rarely agree on that number.
    bool writeAudio(const float* interleaved, int frames, std::string* err);

    /// One packet of a copied stream, in that stream's *input* time base and
    /// already shifted so that the copy's zero is the file's. It goes through
    /// the same bitstream chain and the same muxer call an encoded packet does
    /// — which is the whole reason the packet path cost so little: `writePacket`
    /// was already codec-agnostic, and a copied stream differs from an encoded
    /// one by where its `srcTimeBase` came from.
    ///
    /// `desc` indexes the resolved stream list — `outputStreams()`'s answer —
    /// which is the same numbering `CopyStreams` was built against.
    bool writeCopiedPacket(size_t desc, AVPacket* pkt, std::string* err);

    /// One decoded cue, re-encoded into this stream's subtitle codec.
    ///
    /// **The timing is the packet's, not the subtitle's.**
    /// `avcodec_encode_subtitle` refuses a non-zero `start_display_time`
    /// outright and every text encoder in libavcodec ignores `pts` — what a
    /// muxer writes as the moment a line appears is `pkt->pts` and how long it
    /// stays is `pkt->duration`. So the two milliseconds arrive here as
    /// milliseconds, the stream's `srcTimeBase` is 1/1000, and the rescale into
    /// the muxer's clock is the one `writePacket` already does.
    bool writeSubtitle(size_t desc, AVSubtitle* sub, int64_t fromMs, int64_t toMs,
                       std::string* err);

    /// Flush both encoders and write the trailer. Called even on a cancelled
    /// render: an mp4 whose trailer never went down has no index and plays
    /// nowhere, so stopping half way still has to leave the part that was
    /// rendered watchable.
    bool finish(std::string* err);

    /// The size on disk, stat'd once the file is closed rather than taken from
    /// the write position: +faststart rewrites an mp4 after the trailer, and
    /// the position left behind reported three kilobytes for a file of three
    /// quarters of a megabyte. A destination that is not a file at all reports
    /// what was *sent*, which is the only honest number a socket has.
    int64_t bytesSoFar() const;

    /// How many files the muxer opened **beside** the one it was named with.
    ///
    /// Zero for an ordinary render, which is what makes this something nothing
    /// has to know about: one muxer, one file, and the file is the path. It is
    /// the segments of an `hls` or a `segment` render, the chunks of a `dash`
    /// one, the pictures of an `image2` one, and the destinations of a `tee` —
    /// counted distinct, because a playlist rewritten on every segment is one
    /// file and not forty.
    ///
    /// **A working name the muxer renames onto the destination is not a piece.**
    /// hlsenc writes its playlist to `out/hls.m3u8.tmp` and renames it, so the
    /// file that *is* `path` reaches `io_open` under a name that is not, and the
    /// exclusion above misses it — one segment too many for every hls render,
    /// which the progress panel draws as a file that is not there. `finish()`
    /// resolves it by *asking the filesystem* once, after everything is closed
    /// and renamed (see `resolveRenames`), rather than by knowing which muxers
    /// use which suffix. A build whose hlsenc writes the playlist in place needs
    /// nothing resolved and answers the same number.
    int64_t piecesWritten() const;

    /// Everything that was opened, in the order it was opened, with what each
    /// came to — resolved, so a piece names the file that exists rather than the
    /// working name it was written under. For a caller that wants to say *which*
    /// files a render produced rather than how many, which is the only way to
    /// answer "is this count right" without re-deriving somebody's numbering.
    struct Piece {
        std::string url;
        int64_t bytes = 0;
        bool file = false;      ///< a local path, so `bytes` is on disk
    };
    std::vector<Piece> pieces() const;

    /// What was written, on disk. A path with a frame-number pattern in it is
    /// a run of files rather than one, so it is measured as one — see the note
    /// in `finish()`.
    ///
    /// Only the fallback now: what the muxer actually opened is recorded as it
    /// opens it, and this is what answers when a muxer wrote its files through
    /// some route that never reached `io_open`.
    static int64_t sizeOnDisk(const std::string& path, int64_t startNumber);

    /// Whether anything in this file is fed by the mix.
    ///
    /// **Only mix-fed streams**, which is the whole point: a copied audio track
    /// is packets out of a demuxer and nothing decodes a clip's sound to make
    /// it, so counting one here would open every clip's audio reader on behalf
    /// of a stream that will never ask for a sample. Mutation-tested, and worth
    /// being exact about — dropping the `!copied` term costs a decode per clip
    /// and changes nothing that is written, because `writeAudio` skips a copied
    /// stream itself. It is a performance guard. The `outputStreams()` exception
    /// beside it, which keeps a *copied* audio stream on a silent timeline, is
    /// the correctness one: without that, "extract the soundtrack" writes a file
    /// with no streams in it.
    bool hasAudio() const;

private:
    /// Which output frames are made keyframes, whatever the GOP says.
    ///
    /// `-force_key_frames` is ffmpeg's, not any encoder's: what it does is set
    /// `pict_type = I` on the frame before it goes in, and every encoder that
    /// honours that then starts a GOP there. Both of ffmpeg's forms are here
    /// because they answer different questions — a list of times is "cut here,
    /// here and here", and `expr:` is a rule. **A keyframe where an edit cuts is
    /// what makes a file that can be cut again**, which is the whole reason the
    /// list form matters in this application.
    struct KeyFrames {
        bool on = false;
        std::vector<double> times;      ///< seconds into the output, sorted
        size_t next = 0;
        AVExpr* expr = nullptr;         ///< `expr:`, evaluated per frame

        // ffmpeg's own variables, kept across frames because the expression
        // people actually write — `gte(t,n_forced*2)` — is about the last one.
        double nForced = 0;
        double prevForcedN = -1;
        double prevForcedT = -1;

        bool parse(const std::string& text, std::string* err);
        bool wants(int64_t n, double t);
        ~KeyFrames();
    };

    /// One output stream: its description, the muxer's stream, and whatever a
    /// stream of its kind needs to be fed.
    struct Out {
        ExportStream desc;
        size_t descIndex = 0;           ///< where it sits in the resolved list
        AVStream* st = nullptr;
        AVCodecContext* enc = nullptr;

        /// Packets from a demuxer rather than from an encoder. `enc` is null
        /// for one of these and every loop that feeds encoders steps over it.
        bool copied = false;

        /// The time base the packets arrive in: an encoder's, or the input
        /// stream's for a copy. One field rather than two branches at the
        /// muxer, which is what let the packet path reuse `writePacket` whole.
        AVRational srcTimeBase{1, 1};

        // video
        AVFrame* vframe = nullptr;
        SwsContext* toEncoder = nullptr;
        /// This stream's encoder was opened against a hardware frames context,
        /// so `vframe` and `toEncoder` are both null and the picture arrives
        /// through `writeVideoFrame`.
        bool native = false;
        KeyFrames keys;
        int frameFlags = 0;             ///< interlaced/field order, per frame

        /// The packet chain between this encoder and the muxer — `-bsf:v`.
        /// `av_bsf_list_finalize` folds a whole chain into one context, so what
        /// runs here is what a command line's comma-separated list runs.
        AVBSFContext* bsf = nullptr;
        AVPacket* bsfPkt = nullptr;

        // Two-pass. The handoff between the passes is a file on disk, always,
        // and which file is `-passlogfile` — which is ffmpeg's own option and
        // not the encoder's, so it never reaches av_opt_set.
        std::FILE* statsLog = nullptr;  ///< pass 1, when the encoder does not keep its own
        std::string statsIn;            ///< pass 2, read back and pointed at by the context
        bool statsWritten = false;

        // audio: its own resampler and fifo, because the encoder it feeds has
        // its own sample format, rate and frame size and nothing says two
        // streams in one file agree about any of them.
        AVFrame* aframe = nullptr;
        AVFrame* aconv = nullptr;
        SwrContext* swr = nullptr;
        AVAudioFifo* fifo = nullptr;
        int frameSize = 1024;
        int64_t audioPts = 0;

        // subtitles: somewhere for the encoder to write. `avcodec_encode_subtitle`
        // takes a caller's buffer rather than allocating a packet, which is the
        // one place libavcodec still works that way — so the buffer is the
        // stream's, allocated once, rather than a megabyte per cue.
        std::vector<uint8_t> subBuf;

        /// Everything above that libav owns, given back.
        ///
        /// **It is a destructor rather than a step in `close()` because a
        /// stream that fails to open never reaches the list `close()` walks.**
        /// The refusals that matter here happen *after* `avcodec_open2` has
        /// succeeded — a bitstream chain that will not build, a fourcc that is
        /// not four characters — so what was dropped on the floor was an open
        /// encoder, its scaler, its frames and, on the hardware path, a
        /// reference pinning a device's whole surface pool. Every retry leaked
        /// another, and retrying is the obvious thing to do with a field you
        /// have just been told is wrong.
        ~Out();
        Out() = default;
        Out(const Out&) = delete;
        Out& operator=(const Out&) = delete;
    };

    void close();

    /// Whether the encoders are opened with AV_CODEC_FLAG_GLOBAL_HEADER —
    /// which is not only `AVFMT_GLOBALHEADER`. See the note above the
    /// definition: a muxer that does not write the file it was named with
    /// cannot answer for the format that eventually gets the packets.
    bool wantsGlobalHeader() const;

    bool openVideoStream(Out& o, std::string* err);
    bool openAudioStream(Out& o, bool* skipped, std::string* err);
    bool openAttachment(Out& o, std::string* err);

    /// A stream of cues rather than of frames: no pixel format, no rate
    /// control, no fifo. What it does need that nothing else does is its
    /// *decoder's* header, which is where an ASS file keeps its styles.
    bool openSubtitleStream(Out& o, SubtitleStreams* subs, std::string* err);

    /// A stream that is the bytes that were already there: the muxer is told
    /// about the *input* stream's parameters, and no encoder is opened at all.
    bool openCopyStream(Out& o, CopyStreams& copies, std::string* err);

    /// Metadata, language, disposition and codec tag — everything the muxer is
    /// told about a stream that is not the bitstream itself.
    bool describeStream(Out& o, std::string* err);
    bool addChapters(std::string* err);

    /// `-bsf:v h264_mp4toannexb,dump_extra` — built, initialised, and the
    /// stream's own parameters taken from what comes out of the far end. A
    /// bitstream filter is allowed to change the extradata and the codec tag,
    /// so the muxer has to be told about the *filtered* stream and not the
    /// encoder's.
    bool openBitstreamFilters(Out& o, std::string* err);

    /// `-pass`/`-passlogfile`. Two options that are ffmpeg's rather than any
    /// encoder's, so they are taken out of the bag before it is applied.
    bool setUpPasses(Out& o, const AVCodec* codec, std::string* err);

    /// Hand one stream's encoder every whole frame its fifo can fill. At the
    /// end of the job `flushTail` takes the short one too.
    bool drainFifo(Out& o, bool flushTail, std::string* err);
    bool encode(Out& o, AVFrame* frame, std::string* err);

    /// One encoded packet through the stream's bitstream chain and into the
    /// muxer. `flush` sends the chain its end-of-stream and drains what falls
    /// out, which is how a filter that buffers gets to write its last packet.
    bool writePacket(Out& o, AVPacket* pkt, std::string* err);
    bool drainBsf(Out& o, std::string* err);

    /// A failed write, said in terms of where it was going. A destination that
    /// is not a file fails in ways a file does not — a socket closed by the far
    /// end, a stream key refused after the connection came up — and none of
    /// them is a defect in this application.
    std::string writeFailure(int rc) const;

    // ── every destination this muxer opens ─────────────────────────────────
    //
    // libavformat calls `io_open` for the primary output, for every segment a
    // segmenter starts, for every chunk DASH writes, for every slave `tee`
    // feeds and for every picture `image2` numbers — and `io_close2` when each
    // is done with. Overriding the pair is how a class that only ever knew
    // about one file comes to know what a render made, without a second
    // implementation of anybody's numbering scheme.
    //
    // They are static because libavformat takes function pointers; the Writer
    // arrives through `AVFormatContext::opaque`, which libavformat itself never
    // touches and which ffmpeg's own CLI uses for exactly this.
    static int ioOpen(AVFormatContext* s, AVIOContext** pb, const char* url,
                      int flags, AVDictionary** options);
    static int ioClose(AVFormatContext* s, AVIOContext* pb);
    void noteOpened(const std::string& url, AVIOContext* pb, AVDictionary* leftover);
    void noteClosed(const std::string& url, int64_t sent);

    /// Fold a working name onto the file it became. Run once, from `finish()`,
    /// after every close and every rename the muxer was going to do — see
    /// `piecesWritten()` for why hls needs it and why this asks the filesystem
    /// instead of knowing about suffixes.
    void resolveRenames();

    ExportSettings settings_;
    AVFormatContext* oc_ = nullptr;
    AVPacket* pkt_ = nullptr;
    std::vector<std::unique_ptr<Out>> outs_;
    int64_t bytes_ = 0;
    bool headerWritten_ = false;
    bool finished_ = false;

    /// The half of `formatOptions` that is not the muxer's. Handed to every
    /// `avio_open2` this render does, because that is where a protocol's
    /// options are taken and there is no other moment to take them.
    AVDictionary* protocolOpts_ = nullptr;

    /// The first protocol option nothing consumed. An unknown key is an error
    /// here as it is everywhere else, but it cannot be *reported* from inside a
    /// libavformat callback — so it is carried out to `open()`, which is the
    /// call that can refuse.
    std::string protocolErr_;

    std::vector<Piece> wrote_;              ///< in the order they were opened
    std::map<AVIOContext*, std::string> live_;   ///< open right now, by handle

    /// The pool the composite arrives in, borrowed from the frame source for
    /// the life of `open()`. Not owned: the source outlives the writer.
    AVBufferRef* hwFrames_ = nullptr;
    bool native_ = false;
};

} // namespace ffmpegbro
