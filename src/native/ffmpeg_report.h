// The render's back-channel: everything libav* has to say, and everything a
// filter measures.
//
// Until this existed a render could report four numbers and, on failure, one
// string. Everything else libav* said went nowhere: `av_log_set_callback` was
// never installed, so an encoder that clamped a bitrate, a muxer that refused a
// tag or a filter that warned about its arguments said so into a void. When a
// render came out wrong there was nothing to look at.
//
// The other half is bigger. A whole family of filters produces *information*
// rather than pictures — `cropdetect`, `blackdetect`, `silencedetect`,
// `ebur128`, `signalstats`, `astats`, `psnr`, `ssim`, `libvmaf`, `freezedetect`,
// `scdet` — and they say it in two ways: some log it, and some attach it to the
// frames that pass through them as `AVFrame` metadata. The second kind is a
// *time series*, not a log, and it is what makes measurement something the
// application can act on rather than something you read out of a terminal.
//
// So there are two rings here, drained through one call. Five decisions about
// them are load-bearing:
//
// **The callback is global, arbitrary-threaded, and always installed.** libav
// calls it from whatever thread was logging — a libavcodec worker, the render
// thread, the UI thread during a `probe()` — so everything it touches is under
// one mutex and it allocates nothing in the steady state: the ring's slots are
// reused and their `std::string`s keep the capacity they grew to.
//
// **It captures outside a render as well, and every record says which render it
// belongs to.** Installing and removing it around a job would be the tidier
// story and the wrong one: a probe that fails, a decoder that complains during
// playback, and a muxer finishing a file *after* the job has published its
// terminal status are all things somebody needs to see, and the last of them
// happens in the window an uninstall would have to race. `job` is 0 for
// anything said while nothing was rendering, and the surface filters on it.
//
// **A custom callback receives every level, including trace.** The default
// callback is where libav's `av_log_get_level()` check lives, so replacing it
// hands you everything the library ever emits — a chatty filter at debug level
// is thousands of lines a second. The threshold is therefore ours, and it is
// applied before anything is formatted. It is also *not the same threshold as
// the console's*: `registerFfmpegBackend` sets `av_log_set_level` to warnings
// so that a windowed build's log stays readable, and this keeps everything down
// to info regardless, because the detail nobody wants while things are working
// is exactly the detail wanted afterwards. There is one callback in the
// process and it does both jobs — printing through bro's logger, recording
// here — since two callbacks is one callback, whichever was installed last.
//
// **Both rings are bounded and say how much they dropped.** A long render with
// `cropdetect` on it emits four values a frame; unbounded growth is a leak with
// a nice name. The consumer polls from its animation frame and keeps whatever
// series it cares about, so the ring only ever has to hold what accumulates
// between two drains — and when it does not, the caller is told how many it
// missed rather than being handed a series with an invisible hole in it.
//
// **The drain is a cursor, not a flush.** Records are numbered monotonically
// and never renumbered, so "everything since seq N" is a question with the same
// answer whoever asks and however often. That is what lets the surface keep
// reading a render's last words after the job has torn itself down: the rings
// belong to the process, not to the job.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct AVDictionary;

namespace ffmpegbro {

/// One line libav* (or the renderer itself) had to say.
struct LogRecord {
    uint64_t seq = 0;       ///< monotonic, 1-based; the drain cursor
    uint64_t job = 0;       ///< the render it was said during, 0 for none
    double at = 0.0;        ///< seconds since the capture was installed
    int level = 0;          ///< AV_LOG_*; small is severe
    std::string source;     ///< "libx264", "cropdetect@6", "mp4", "render"
    std::string text;
};

/// One value a filter attached to a frame on its way through the graph.
///
/// The key is libavfilter's own and is kept verbatim — `lavfi.cropdetect.x1`,
/// `lavfi.r128.M`, `lavfi.signalstats.YAVG`. It names both the filter and the
/// quantity, which is exactly what a series wants to be called, and normalising
/// it would mean writing down a table of filters this application refuses to
/// have.
struct MetaRecord {
    uint64_t seq = 0;
    uint64_t job = 0;
    double at = 0.0;        ///< the frame's own timestamp, in the graph's seconds
    std::string stream;     ///< "video" or "audio"
    std::string key;
    std::string value;
};

/// Silence this thread's half of the channel for the length of a scope.
///
/// There is exactly one capability in this binary that cannot be enumerated
/// and can only be asked by *trying*: whether this build's `image2` demuxer
/// was compiled with globbing. libav answers `ENOSYS` at `read_header` and
/// nowhere else, and on the way out it says so at error level about a file
/// nobody asked to open. A question the application put to itself is not
/// something a render said, so it does not belong in the report — and it is
/// per-thread, so a render running beside the question keeps every word.
class LogQuiet {
public:
    LogQuiet();
    ~LogQuiet();
    LogQuiet(const LogQuiet&) = delete;
    LogQuiet& operator=(const LogQuiet&) = delete;
};

/// Take over `av_log`. Safe to call more than once; the second call does
/// nothing. Call it before the engine exists, so that startup has somewhere to
/// say things too.
void installLogCapture();

/// A render is beginning. Returns its number, which every record emitted from
/// now until `endRenderReport()` carries.
uint64_t beginRenderReport();
void endRenderReport();

/// The render currently running, or 0.
uint64_t currentRenderJob();

/// Something the renderer itself has to say, in the same channel as libav's own
/// words. The report is "what the render said", and the render is a speaker:
/// the graph running at a different rate from the output, a trailer that would
/// not go down cleanly after a Stop, the file that was written. `level` is an
/// `AV_LOG_*` value so that one scale orders the whole channel.
void reportNote(int level, const char* source, const std::string& text);

/// Every key on a frame leaving the filter graph. Cheap when there are none,
/// which is the ordinary case: a graph with no measuring filter in it attaches
/// no metadata and this is one null check per frame.
void reportFrameMetadata(bool audio, double at, const AVDictionary* meta);

/// How often the writing end lost its destination and got it back.
///
/// **The `fifo` muxer has no API for this and there is nowhere else to ask.**
/// It recovers on a thread of its own, exposes no counter, and the only trace a
/// recovery leaves is what it says — `Recovery successful`, `Recovery failed: …`
/// and `FIFO queue full`, from libavformat/fifo.c, at info and warning level.
/// So it is counted where every line libav emits already passes, which is the
/// log callback, and it is counted there rather than by draining the ring
/// because the ring holds 512 records and a stream render is far longer than
/// that.
///
/// **A render that recovered is not a render that did not**, which is the whole
/// reason this is counted at all: the file has a gap in it and the report has to
/// say so. Reported the way the paced walk reports the pictures it dropped —
/// a note at the end, with the number in it.
struct WriteRecovery {
    int64_t recovered = 0;   ///< times the destination came back
    int64_t failed = 0;      ///< attempts that did not, each followed by a wait
    int64_t overflowed = 0;  ///< times the queue filled — packets dropped or blocked
};

/// The tally since `beginRenderReport()`, which resets it. Zero for every render
/// that is not wrapped in a fifo, because nothing else says these words.
WriteRecovery writeRecovery();

struct ReportDrain {
    std::vector<LogRecord> logs;
    std::vector<MetaRecord> meta;
    uint64_t logCursor = 0;     ///< pass back as `sinceLog` next time
    uint64_t metaCursor = 0;
    uint64_t logsDropped = 0;   ///< records this caller missed to the ring
    uint64_t metaDropped = 0;
    uint64_t job = 0;           ///< the render running as of this drain
};

/// Everything numbered `sinceLog`/`sinceMeta` or later, up to `max` of each.
/// A cursor of 0 means "whatever you still have" and is never reported as a
/// drop — a consumer that starts late has not lost anything it was promised.
ReportDrain drainReport(uint64_t sinceLog, uint64_t sinceMeta, int max);

/// "error", "warning", "info"… — the level as a word, since JS has no use for
/// libav's numbering and a table of it in the UI would be a copy to go stale.
const char* logLevelName(int level);

/// How many messages the log ring holds. On the surface so that the test which
/// floods it can assert the bound and the dropped count against the real number
/// rather than against a copy of it — which is the whole of what an accessor to
/// a compile-time constant is for. The meta ring is bounded the same way and had
/// the same accessor; it went, because nothing asked and an accessor nobody
/// calls is a claim that somebody does.
int logCapacity();

} // namespace ffmpegbro
