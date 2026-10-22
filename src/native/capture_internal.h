// Shared device, output, and reader structures for ffmpeg_capture.cpp and
// ffmpeg_capture_session.cpp. See ffmpeg_capture.h.
#pragma once

#include "ffmpeg_capture.h"

#include "capture_graph.h"
#include "export_frame.h"
#include "export_writer.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <atomic>
#include <chrono>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace ffmpegbro {
namespace capture_detail {

using Clock = std::chrono::steady_clock;

/// One open device: its demuxer, the two decoders it might have, and the
/// converters into the currency the writer takes.
///
/// It is not a `SourceVideo` and a `SourceAudio` because those own a demuxer
/// each, and one device is one demuxer: `-f dshow -i "video=Camera:audio=Mic"`
/// is a single `-i` carrying both, and opening it twice would open the camera
/// twice — which on Windows is not a slow path, it is an error.
///
/// **One of these per input, and in a session one reader thread per one of
/// these.** Everything in here is touched by that thread alone once the session
/// is running, which is what makes the decoders and the packet and frame
/// scratch safe without a lock around any of them.
struct Device {
    MediaInput in;
    int index = 0;              ///< the number in `[<index>:v]`

    AVFormatContext* fmt = nullptr;
    AVPacket* pkt = nullptr;
    AVFrame* frame = nullptr;

    int videoStream = -1;
    int audioStream = -1;
    AVCodecContext* vdec = nullptr;
    AVCodecContext* adec = nullptr;

    SwsContext* toRgba = nullptr;
    AVPixelFormat swsFmt = AV_PIX_FMT_NONE;
    SwrContext* swr = nullptr;
    AVChannelLayout outLayout{};

    /// What this device offers a graph, and what a session waits for.
    bool hasVideo() const { return vdec != nullptr; }
    bool hasAudio() const { return adec != nullptr; }
    std::string name() const {
        return in.format.empty() ? in.path : in.format + " " + in.path;
    }

    ~Device() {
        if (toRgba) sws_freeContext(toRgba);
        if (swr) swr_free(&swr);
        av_channel_layout_uninit(&outLayout);
        if (frame) av_frame_free(&frame);
        if (pkt) av_packet_free(&pkt);
        if (vdec) avcodec_free_context(&vdec);
        if (adec) avcodec_free_context(&adec);
        if (fmt) avformat_close_input(&fmt);
    }
};

using DeviceList = std::vector<std::shared_ptr<Device>>;

/// One picture the recording writes: where it goes, and where it has got to.
///
/// **Per destination and not per recording**, because a graph can end in several
/// pads and each of them is a picture in its own right — arriving at its own
/// rate, stalling on its own, and holding its own last frame over a gap. One
/// `nextIndex` between them would have a fast pad dragging a slow one's
/// timestamps along with it.
struct VidDest {
    bool composite = false;     ///< `writeVideo`, which feeds every composite stream
    size_t desc = 0;            ///< otherwise `writeVideoTo`, by resolved index
    std::string label;          ///< the pad it reads; empty for the composite
    Rgba held;
    bool haveHeld = false;
    int64_t next = 0;
};

/// The same for a soundtrack. There is no held-last-block here: silence in a
/// recording is silence, and the writer's fifo already accounts for what it has
/// been given.
struct AudDest {
    bool mix = false;           ///< `writeAudio`, which feeds every mix-fed stream
    size_t desc = 0;
    std::string label;
    int64_t written = 0;
};

/// Everything downstream of the graph for **one file**: its writer, one
/// destination per pad it maps, and the rules that place what arrives.
///
/// It is shared by both of the loops below because **neither of them changes
/// what happens to a frame once it has left the graph** — a session and a
/// single device differ entirely in how frames are got hold of, and not at all
/// in where they go. Keeping that in one object is what stops the wall-clock
/// loop growing a second, slightly different, answer to `-t`.
///
/// **One of these per file, and a recording can be asked for several** — see
/// `Files` below and `CaptureSettings::outputs`. What belongs to the session
/// rather than to the file is held by reference or by `Files`: the graph, the
/// status, the limit, and the one `stop` that ends every file together, because
/// a recording that half failed is a recording that failed.
struct Output {
    ExportSettings& cfg;
    ExportStatus& st;
    CaptureGraph* graph = nullptr;
    bool& stop;

    /// Zero means until stopped. It is `-t` on the input, which is where a
    /// command line puts it — and it is judged on *output* time, so a graph
    /// that changes the rate still records the number of seconds asked for.
    /// The session's, copied in: `place` reads it per frame.
    double limit = 0.0;
    /// Is a picture going to arrive at all? It decides what happens to sound
    /// that turns up before one: dropped, because letting it in would put the
    /// whole soundtrack ahead of the picture by however long the device took to
    /// wake up.
    bool expectsPicture = true;
    /// Only for a recording with no graph, where there is one device and the
    /// question is whether it had a soundtrack.
    bool deviceHasAudio = false;
    /// The file the recording's frame count and its `-t` percentage are about.
    /// True for `outputs[0]` and nothing else: a counter that jumped between
    /// two files' clocks would be a counter about neither.
    bool primary = true;
    /// **Did this file name a size, before `settleOutput` filled the blanks?**
    /// Recorded in the constructor because that is the last moment the two are
    /// distinguishable, and they have to be: a pad's settled size is the right
    /// answer for a file that said nothing and is exactly the wrong one for a
    /// proxy, which exists to be another size.
    bool sizeAsked = false;

    Writer writer;
    std::vector<VidDest> vids;
    std::vector<AudDest> auds;
    AudDest* mixDest = nullptr;
    bool opened = false;
    double epoch = -1.0;        ///< the first picture's timestamp; this file's zero
    std::string err;

    Output(ExportSettings& settings, ExportStatus& status, CaptureGraph* g, bool& stopping)
        : cfg(settings), st(status), graph(g), stop(stopping) {}

    /// **The file is opened for what the graph turned out to produce.** A pad's
    /// size is not knowable until libavfilter has configured the graph, and the
    /// graph is not configured until a device has handed over a frame — so with
    /// a graph this runs on the first frame rather than up front, which is the
    /// one ordering difference between a recording and a render on this path.
    bool open(std::string* why);

    bool writeOne(VidDest& v, const Rgba& pic, int64_t n);
    /// Where this picture belongs, and everything owed before it. False when
    /// the recording is over — the limit was reached, or a write failed.
    bool place(VidDest& v, double at, const Rgba& pic);
    bool writeSound(AudDest& a, double at, const float* samples, int frames);
    /// One frame off one pad of the graph, to every destination reading it. A
    /// pad read both as the composite and by name is one sink written twice,
    /// which for a picture is simply the same picture in two streams.
    bool emit(const CaptureGraph::Taken& tk);
};

/// Every file this recording writes, as the one thing the loops below talk to.
///
/// **A recording is one reading of the devices and one graph; the files are
/// what is on the end of it.** So this is where the session's answers live —
/// the limit, the stop, whether anything is open yet — and each `Output` under
/// it holds only what is that file's: its writer, its pads, its size and its
/// own zero. Neither loop learns how many there are.
///
/// **They fail together and finish together.** A second file that stopped
/// writing while the first carried on would be a recording somebody has to
/// check afterwards; and the trailer of every one of them goes down whatever
/// happened, for the reason it does for one — a recording that lost its index
/// has lost the only copy of something that happened once.
struct Files {
    ExportStatus& st;
    std::vector<std::unique_ptr<Output>> all;
    bool stop = false;
    bool opened = false;
    double limit = 0.0;

    explicit Files(ExportStatus& status) : st(status) {}

    Output& first() { return *all.front(); }

    /// One `Output` per file, in the order they were asked for.
    ///
    /// `cfgs` is `CaptureSettings::outputs`, already normalised and settled;
    /// it is held by the caller because `Output` writes back into it — a pad's
    /// size arrives late and the writer is opened from the same object.
    void build(std::vector<ExportSettings>& cfgs, const std::vector<char>& sizeAsked,
               CaptureGraph* graph, bool expectsPicture, bool deviceHasAudio) {
        for (size_t i = 0; i < cfgs.size(); ++i) {
            auto o = std::make_unique<Output>(cfgs[i], st, graph, stop);
            o->limit = limit;
            o->expectsPicture = expectsPicture;
            o->deviceHasAudio = deviceHasAudio;
            o->primary = i == 0;
            o->sizeAsked = i < sizeAsked.size() && sizeAsked[i];
            all.push_back(std::move(o));
        }
    }

    /// Open every file, primary first.
    ///
    /// **The order matters for exactly one thing: the rate.** The composite
    /// pad's rate is the recording's, it is not known until the graph has
    /// configured, and every file is placed on it — two files disagreeing about
    /// which output frame a moment is would be two files disagreeing about when
    /// the recording started. A file's *size* is its own; its rate is not.
    bool open(std::string* why) {
        if (!all.front()->open(why)) return false;
        const double rate = all.front()->cfg.fps;
        for (size_t i = 1; i < all.size(); ++i) {
            all[i]->cfg.fps = rate;
            if (!all[i]->open(why)) return false;
        }
        opened = true;
        return true;
    }

    /// One frame off one pad, to every file that maps it. A file that does not
    /// is not asked and is not an error: that is what mapping means.
    bool emit(const CaptureGraph::Taken& tk) {
        for (auto& o : all) if (!o->emit(tk)) return false;
        return !stop;
    }

    /// The device's own picture, straight through — the no-graph path, where
    /// there is one pad and it has no name.
    ///
    /// The canvas was converted once, at the first file's size, and a file at
    /// another size takes the difference in its writer's scaler. Converting per
    /// file would be the better picture and N conversions off one decoded
    /// frame; a proxy is smaller than its master, so the extra step is a
    /// downscale of a downscale and the master — the one anybody keeps — is
    /// converted exactly once.
    bool direct(double at, const Rgba& pic) {
        for (auto& o : all) {
            if (o->vids.empty()) continue;
            if (!o->place(o->vids.front(), at, pic)) return false;
        }
        return !stop;
    }

    /// The same for the device's own sound.
    bool directSound(double at, const float* samples, int frames) {
        for (auto& o : all) {
            if (!o->mixDest) continue;
            if (!o->writeSound(*o->mixDest, at, samples, frames)) return false;
        }
        return !stop;
    }

    /// What the recording has written, which is the sum and not any one file's:
    /// somebody watching a capture wants to know what it is costing the disk.
    int64_t bytesSoFar() const {
        int64_t n = 0;
        for (const auto& o : all) if (o->opened) n += o->writer.bytesSoFar();
        return n;
    }
    int piecesWritten() const {
        int n = 0;
        for (const auto& o : all) if (o->opened) n += o->writer.piecesWritten();
        return n;
    }

    /// Every trailer, and the **first** failure back. Every one is attempted
    /// whatever the others did: see above.
    bool finish(std::string* err) {
        bool ok = true;
        for (auto& o : all) {
            if (!o->opened) continue;
            std::string why;
            if (!o->writer.finish(&why) && ok) { *err = why; ok = false; }
        }
        return ok;
    }
};

/// How many blocks of sound one feed may hold before the job thread has taken
/// them.
///
/// **Sound is a queue and pictures are a slot**, and that difference is the
/// whole of decision six: a picture superseded before the next tick had no tick
/// to appear at, so replacing it loses nothing, while a block of samples
/// dropped or repeated is audible. Bounded all the same, because a job thread
/// that has stalled must not be able to make a reader grow memory for as long
/// as the recording lasts — a hundred and twenty-eight blocks is about two and
/// a half seconds at 1024 samples and 48 kHz, and losing the oldest of them is
/// reported.
constexpr size_t kSoundQueue = 128;

/// What one reader thread hands to the job thread.
///
/// Everything in here is under `m`, and nothing else crosses: the demuxer, the
/// decoders and the scratch frame stay on the reader thread, and what arrives
/// here is an owned reference (`av_frame_ref`) rather than a copy of any
/// pixels.
struct Hand {
    std::mutex m;
    /// The newest picture the job thread has not taken. **Newer replaces
    /// older**: the one that goes is the one that was never going to be shown.
    AVFrame* latest = nullptr;
    bool sawPicture = false;
    /// Sound in the order it arrived, each block with the moment it did.
    std::deque<std::pair<AVFrame*, double>> sound;
    bool warnedSound = false;
    bool ended = false;

    ~Hand() {
        if (latest) av_frame_free(&latest);
        for (auto& b : sound) av_frame_free(&b.first);
    }
};

/// The reader threads and their hand-off state, joined however this leaves.
///
/// **The join is in a destructor** for the reason `job::Slot`'s is: a joinable
/// `std::thread` destroyed is `std::terminate`, which reads as "the last thing
/// it printed crashed" and is nothing of the kind. Every early return in the
/// session below therefore stops and joins its readers without saying so.
struct Readers {
    std::vector<std::unique_ptr<Hand>> hands;
    std::vector<std::thread> threads;
    std::atomic<bool> quit{false};

    void stopAll() {
        quit.store(true);
        for (auto& t : threads) if (t.joinable()) t.join();
        threads.clear();
    }
    ~Readers() { stopAll(); }
};

std::vector<MediaInput> sourcesOf(const CaptureSettings& s);
double limitOf(const std::vector<MediaInput>& srcs);
bool openDevice(Device& d, const MediaInput& in, int index, const CaptureSettings& s,
                std::string* err);
void settleOutput(ExportSettings& out, const DeviceList& devs);
std::vector<CaptureGraph::FeedSource> feedsOf(const DeviceList& devs);

void runDirect(CaptureSettings& s, const std::vector<char>& sizeAsked, ExportStatus& st,
               const std::shared_ptr<Device>& dev,
               const std::function<double()>& secondsSince,
               const std::function<void(const std::string&)>& refuse);

void runSession(CaptureSettings& s, const std::vector<char>& sizeAsked, ExportStatus& st,
                const DeviceList& devs,
                const std::function<double()>& secondsSince,
                const std::function<void(const std::string&)>& refuse);

void runCapture(CaptureSettings s, DeviceList devs, std::vector<char> sizeAsked);

} // namespace capture_detail
} // namespace ffmpegbro
